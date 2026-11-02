"""Real authenticated pipelines retain immutable Controller provenance."""
from dataclasses import replace
import hashlib
import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from runner.api import RunnerAPI
from runner.call_context import RedisCallContextStore
from runner.metrics import RunnerMetrics
from runner.toolkit.runtime.contracts import RequestContext
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import _runtime, _desired_state, RUNTIME_CREDENTIAL, Telemetry


def install(store, context_id, *, generation=2, adapter="litellm-generic-guardrail", credential=None):
    desired = _desired_state()
    desired.generation = generation
    desired.endpoints[0].telemetry_context_id = context_id
    desired.endpoints[0].adapter = adapter
    if credential is not None:
        desired.endpoints[0].verification.credentials[0].sha256 = hashlib.sha256(credential.encode()).hexdigest()
    store.apply(desired)
    return desired


@pytest.mark.asyncio
async def test_real_http_pipeline_uses_auth_snapshot_and_never_public_headers(tmp_path, monkeypatch):
    store, _, engine = _runtime(tmp_path)
    install(store, "private-old-context")
    original = store.authenticate_endpoint_snapshot

    def race(endpoint, credential):
        snapshot = original(endpoint, credential)
        install(store, "private-new-context", generation=3, credential="rotated-runtime-secret")
        return snapshot

    monkeypatch.setattr(store, "authenticate_endpoint_snapshot", race)
    telemetry = Telemetry()
    app = FastAPI()
    app.include_router(RunnerAPI(GuardrailRuntimeService(engine, store), store, RunnerMetrics(4), telemetry, "runner", "internal").router)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
            response = await client.post("/runtime/v1/endpoints/fixture-endpoint/beta/litellm_basic_guardrail_api",
                headers={"x-api-key": RUNTIME_CREDENTIAL, "x-guard-allocation-context-id": "forged-header-context"},
                json={"input_type": "request", "texts": ["Hello"], "request_data": {"allocationContextId": "forged-body-context"}})
        assert response.status_code == 200, response.text
        assert telemetry.events[0]["allocationContextId"] == "private-old-context"
        assert telemetry.routing_events[0]["allocationContextId"] == "private-old-context"
        assert original("fixture-endpoint", RUNTIME_CREDENTIAL) is None
        assert original("fixture-endpoint", "rotated-runtime-secret").telemetry_context_id == "private-new-context"
        assert telemetry.events[0]["metadata"]["routerRevision"] == 1
        assert "targetId" in telemetry.events[0]["metadata"]
        assert all(value not in response.text + json.dumps(dict(response.headers))
                   for value in ("private-old-context", "private-new-context", "forged-header-context"))
        assert store.resolve(RequestContext(protocol="litellm", endpoint_id="fixture-endpoint")).allocation_context_id is None
    finally:
        await engine.shutdown()


@pytest.mark.asyncio
async def test_pinned_output_and_redis_serialization_keep_original_context(tmp_path):
    store, _, engine = _runtime(tmp_path)
    install(store, "private-old-context")
    runtime = GuardrailRuntimeService(engine, store)
    routing_events = []
    async def collect(event):
        routing_events.append(event)
    runtime.routing_event_sink = collect
    first = store.authenticate_endpoint_snapshot("fixture-endpoint", RUNTIME_CREDENTIAL)
    context = RequestContext(protocol="litellm", endpoint_id="fixture-endpoint", endpoint_snapshot=first)
    from runner.toolkit.runtime.contracts import ProtectionRequest
    try:
        before = await runtime.evaluate(ProtectionRequest(phase="input", texts=("Hello",), context=context, call_id="pinned-context"))
        install(store, "private-new-context", generation=3)
        current = store.authenticate_endpoint_snapshot("fixture-endpoint", RUNTIME_CREDENTIAL)
        after = await runtime.evaluate(ProtectionRequest(phase="output", texts=("Hello",), context=replace(context, endpoint_snapshot=current), call_id="pinned-context"))
        assert before.allocation_context_id == after.allocation_context_id == "private-old-context"
        assert all(event["allocationContextId"] == "private-old-context" for event in routing_events)
        assert {event["eventType"] for event in routing_events} == {"route_assignment", "completion"}
        with pytest.raises(Exception, match="call_endpoint_authentication_required"):
            await runtime.evaluate(ProtectionRequest(phase="input", texts=("Hello",),
                context=replace(context, endpoint_snapshot=None), call_id="pinned-context"))
        values = {}
        redis = object.__new__(RedisCallContextStore)
        redis._ttl_seconds = 300
        redis._redis = SimpleNamespace(set=lambda key, value, **_: values.setdefault(key, value), get=values.get)
        resolution = runtime._contexts.get("pinned-context").resolution
        redis.put("pinned-context", (), resolution)
        assert redis.get("pinned-context").resolution.allocation_context_id == "private-old-context"
        assert redis.get("pinned-context").resolution.route_assignment["allocationContextId"] == "private-old-context"
        with pytest.raises(Exception, match="endpoint_snapshot_invalid"):
            store.resolve(replace(context, endpoint_snapshot={"telemetry_context_id": "forged"}))
        from runner.routing import RoutingError, public_route_assignment
        with pytest.raises(RoutingError) as failure:
            store.resolve(replace(context, business_request=(("x-test", "x" * 2049),)))
        assert failure.value.assignment["allocationContextId"] == "private-old-context"
        assert "allocationContextId" not in public_route_assignment(failure.value.assignment)
    finally:
        await engine.shutdown()


@pytest.mark.asyncio
async def test_scan_pipeline_emits_its_authenticated_snapshot_context(tmp_path):
    store, _, engine = _runtime(tmp_path)
    install(store, "private-scan-context", adapter="f5-scan")
    telemetry = Telemetry()
    app = FastAPI()
    app.include_router(RunnerAPI(GuardrailRuntimeService(engine, store), store, RunnerMetrics(4), telemetry, "runner", "internal").router)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
            response = await client.post("/runtime/v1/endpoints/fixture-endpoint/backend/v1/scans",
                headers={"authorization": f"Bearer {RUNTIME_CREDENTIAL}"}, json={"input": "Hello", "scanDirection": "request"})
        assert response.status_code == 200, response.text
        assert telemetry.events[0]["allocationContextId"] == "private-scan-context"
        assert len(telemetry.routing_events) == 2
        assert all(event["allocationContextId"] == "private-scan-context" for event in telemetry.routing_events)
        assert "private-scan-context" not in response.text + json.dumps(dict(response.headers))
    finally:
        await engine.shutdown()


@pytest.mark.asyncio
async def test_websocket_snapshot_stays_pinned_across_replacement(tmp_path):
    from starlette.testclient import TestClient
    store, _, engine = _runtime(tmp_path)
    install(store, "private-stream-context")
    telemetry = Telemetry()
    app = FastAPI()
    app.include_router(RunnerAPI(GuardrailRuntimeService(engine, store), store, RunnerMetrics(4), telemetry, "runner", "internal").router)
    try:
        with TestClient(app) as client, client.websocket_connect("/runtime/v1/endpoints/fixture-endpoint/guardrails/output-stream",
                headers={"x-api-key": RUNTIME_CREDENTIAL}) as socket:
            socket.send_json({"type": "start", "version": 1, "stream_id": "stream", "protocol": "litellm"})
            ready = socket.receive_json()
            assert ready["type"] == "ready"
            install(store, "private-new-context", generation=3)
            socket.send_json({"type": "delta", "sequence": 0, "text": "Hello"})
            assert socket.receive_json()["type"] == "ack"
            socket.send_json({"type": "end", "sequence": 1})
            frames = []
            while not frames or frames[-1]["type"] not in {"completed", "blocked", "error"}:
                frames.append(socket.receive_json())
            assert frames[-1]["type"] == "completed"
            assert "private-stream-context" not in json.dumps([ready, frames])
        assert telemetry.events[0]["allocationContextId"] == "private-stream-context"
        assert telemetry.routing_events
        assert all(event["allocationContextId"] == "private-stream-context" for event in telemetry.routing_events)
    finally:
        await engine.shutdown()
