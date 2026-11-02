"""Opt-in per-process Endpoint admission at HTTP and WebSocket boundaries."""
from __future__ import annotations

import asyncio
import hashlib
import json
from threading import RLock
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from runner.api import RunnerAPI
from runner.artifact_store import ArtifactStore
from runner.synchronization import RuntimeSynchronizationMiddleware
from runner.tenant_admission import AdmissionRejected, AdmissionUnavailable, EndpointAdmission, TenantAdmission, TenantAdmissionConfiguration
from runner.toolkit.runtime.contracts import ProtectionDecision
from runner.toolkit.runtime.streaming import OutputStreamResult
from tests.test_runner_api import Metrics, Telemetry
from tests.data_plane.test_scan import decision as scan_decision


def store():
    result = object.__new__(ArtifactStore)
    result._lock = RLock()
    result._logging_levels = {}
    result._endpoints = {}
    for endpoint, tenant, adapter in [("a", "tenantA", "litellm-generic-guardrail"),
                                     ("b", "tenantB", "litellm-generic-guardrail"),
                                     ("scan-a", "tenantA", "f5-scan"),
                                     ("legacy", None, "litellm-generic-guardrail"),
                                     ("unknown", "unconfigured", "litellm-generic-guardrail")]:
        result._endpoints[endpoint] = {"_tenant_id": tenant, "_adapter": adapter,
            "credentials": [{"sha256": hashlib.sha256(f"key-{endpoint}".encode()).hexdigest()}]}
    return result


class Runtime:
    def __init__(self):
        self.calls = []
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.canceled = asyncio.Event()

    async def evaluate(self, request, **_kwargs):
        self.calls.append(request.context.endpoint_id)
        if request.texts == ("hold",):
            self.entered.set()
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                self.canceled.set()
                raise
        return ProtectionDecision(decision="allow", action="allow")

    async def evaluate_standalone(self, request, *, validate_decision, **kwargs):
        await self.evaluate(request, **kwargs)
        value = scan_decision()
        validate_decision(value)
        return value

    async def stream_output(self, _request, source, *, ready, **_kwargs):
        self.calls.append("stream")
        await ready(SimpleNamespace(effective_mode="full_buffered", requested_mode="full_buffered"),
                    SimpleNamespace(effective_release_id="release", model_revision_id="model"))
        async for _part in source:
            pass
        return OutputStreamResult(status="completed", released_characters=0, checks=0)


class Authority:
    def __init__(self):
        self.synchronized = True
        self.synchronization_lost = asyncio.Event()


def app_for(*, capacity=2, max_queued=0, timeout=0.25, enabled=True, authority=None, synchronize=False, rate=None, group_rate=None):
    runtime, snapshot = Runtime(), store()
    state = authority or Authority()
    limiter = TenantAdmission(capacity=capacity, tenant_limits={"tenantA": 1, "tenantB": 1},
                              max_queued=max_queued, max_queued_per_tenant=max_queued)
    gate = EndpointAdmission(limiter, timeout_seconds=timeout, serving_authority=lambda: state.synchronized, rate=rate, group_rate=group_rate)
    app = FastAPI()
    app.include_router(RunnerAPI(runtime, snapshot, Metrics(), Telemetry(), "runner", "controller",
                                 tenant_admission=gate if enabled else None).router)
    if synchronize:
        app.add_middleware(RuntimeSynchronizationMiddleware, control=state)
    return app, runtime, snapshot, limiter, state


async def request(client, endpoint="a", text="hello", **kwargs):
    return await client.post(f"/runtime/v1/endpoints/{endpoint}/beta/litellm_basic_guardrail_api",
        headers={"x-api-key": f"key-{endpoint}", **kwargs}, json={"input_type": "request", "texts": [text]})


async def wait_queued(limiter):
    async with asyncio.timeout(1):
        while limiter._queued == 0:
            await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_real_endpoint_owner_caps_ignore_forged_tenant_headers_and_leave_another_tenant_capacity():
    app, runtime, _, _, _ = app_for()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        first = asyncio.create_task(request(client, text="hold"))
        await runtime.entered.wait()
        denied = await request(client, **{"x-tenant": "tenantB", "x-tenant-id": "tenantB"})
        assert denied.status_code == 429 and denied.headers["retry-after"] == "1"
        assert (await client.post("/runtime/v1/endpoints/a/verify", headers={"x-api-key": "key-a"})).status_code == 200
        assert (await request(client, "b")).status_code == 200
        assert runtime.calls == ["a", "b"]
        runtime.release.set()
        assert (await first).status_code == 200
        assert (await request(client)).status_code == 200


@pytest.mark.asyncio
async def test_missing_unknown_owner_and_invalid_authority_fail_closed_while_auth_errors_are_preserved():
    app, runtime, _, _, state = app_for()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        assert (await request(client, "legacy")).status_code == 503
        assert (await request(client, "unknown")).status_code == 503
        assert (await request(client, **{"x-api-key": "incorrect"})).status_code == 401
        state.synchronized = False
        assert (await request(client)).status_code == 503
        assert runtime.calls == []
    legacy, _, _, _, _ = app_for(enabled=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=legacy), base_url="http://runner") as client:
        assert (await request(client, "legacy")).status_code == 200


@pytest.mark.asyncio
async def test_queue_timeout_and_cancel_release_all_capacity_and_waiters():
    app, runtime, _, limiter, _ = app_for(capacity=1, max_queued=1, timeout=0.02)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        first = asyncio.create_task(request(client, text="hold"))
        await runtime.entered.wait()
        assert (await request(client, "b")).status_code == 429
        assert limiter._queued == 0
        queued = asyncio.create_task(request(client, "b"))
        await wait_queued(limiter)
        assert (await request(client, "b")).status_code == 429
        queued.cancel()
        with pytest.raises(asyncio.CancelledError):
            await queued
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert runtime.canceled.is_set()
        assert limiter._queued == limiter._active_total == 0
        assert (await request(client, "b")).status_code == 200


@pytest.mark.asyncio
async def test_owner_is_rechecked_after_queue_wait_without_charging_or_executing_changed_identity():
    app, runtime, snapshot, limiter, _ = app_for(capacity=1, max_queued=1, timeout=1)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        first = asyncio.create_task(request(client, text="hold"))
        await runtime.entered.wait()
        queued = asyncio.create_task(request(client, "b"))
        await wait_queued(limiter)
        snapshot._endpoints["b"]["_tenant_id"] = "tenantA"
        runtime.release.set()
        assert (await first).status_code == 200
        assert (await queued).status_code == 503
        assert runtime.calls == ["a"]
        assert limiter._active_total == 0


@pytest.mark.asyncio
async def test_lease_loss_cancels_queued_and_active_admission_without_capacity_leak():
    app, runtime, _, limiter, state = app_for(capacity=1, max_queued=1, timeout=1, synchronize=True)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        first = asyncio.create_task(request(client, text="hold"))
        await runtime.entered.wait()
        queued = asyncio.create_task(request(client, "b"))
        await wait_queued(limiter)
        state.synchronized = False
        state.synchronization_lost.set()
        assert (await asyncio.wait_for(first, 1)).status_code == 503
        assert (await asyncio.wait_for(queued, 1)).status_code == 503
        assert limiter._active_total == limiter._queued == 0
        state.synchronization_lost = asyncio.Event()
        state.synchronized = True
        assert (await request(client, "b")).status_code == 200


@pytest.mark.asyncio
async def test_scan_keeps_auth_adapter_and_error_envelope_and_shares_tenant_budget():
    app, runtime, snapshot, limiter, _ = app_for()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        url = "/runtime/v1/endpoints/scan-a/backend/v1/scans"
        assert (await client.post(url, json={"input": "hello"})).status_code == 401
        first = asyncio.create_task(request(client, text="hold"))
        await runtime.entered.wait()
        denied = await client.post(url, headers={"authorization": "Bearer key-scan-a"}, json={"input": "hello"})
        assert denied.status_code == 429 and denied.headers["retry-after"] == "1"
        assert denied.json()["detail"]["code"] == "tenant_admission_rejected"
        runtime.release.set()
        await first
        malformed = await client.post(url, headers={"authorization": "Bearer key-scan-a"}, json={})
        assert malformed.status_code == 422 and limiter._active_total == 0
        assert (await client.post(url, headers={"authorization": "Bearer key-scan-a"}, json={"input": "hello"})).status_code == 200
        snapshot._endpoints["scan-a"]["_tenant_id"] = None
        unavailable = await client.post(url, headers={"authorization": "Bearer key-scan-a"}, json={"input": "hello"})
        assert unavailable.status_code == 503
        assert unavailable.json()["detail"]["code"] == "tenant_admission_unavailable"


def test_websocket_holds_one_whole_stream_permit_and_releases_after_disconnect():
    app, _, _, _, _ = app_for()
    path = "/runtime/v1/endpoints/a/guardrails/output-stream"
    with TestClient(app) as client:
        with client.websocket_connect(path, headers={"x-api-key": "key-a"}) as socket:
            socket.send_json({"type": "start", "version": 1, "stream_id": "one", "protocol": "litellm"})
            assert socket.receive_json()["type"] == "ready"
            with pytest.raises(WebSocketDisconnect) as denied:
                with client.websocket_connect(path, headers={"x-api-key": "key-a", "x-tenant": "tenantB"}):
                    pass
            assert denied.value.code == 1013
            blocked = client.post("/runtime/v1/endpoints/a/beta/litellm_basic_guardrail_api",
                headers={"x-api-key": "key-a"}, json={"input_type": "request", "texts": ["hello"]})
            assert blocked.status_code == 429
            other = client.post("/runtime/v1/endpoints/b/beta/litellm_basic_guardrail_api",
                headers={"x-api-key": "key-b"}, json={"input_type": "request", "texts": ["hello"]})
            assert other.status_code == 200
        with client.websocket_connect(path, headers={"x-api-key": "key-a"}) as resumed:
            resumed.send_json({"type": "start", "version": 1, "stream_id": "two", "protocol": "litellm"})
            assert resumed.receive_json()["type"] == "ready"


@pytest.mark.parametrize("endpoint,credential,code", [("a", "wrong", 1008),
    ("legacy", "key-legacy", 1013), ("unknown", "key-unknown", 1013)])
def test_websocket_authentication_and_missing_owner_fail_closed(endpoint, credential, code):
    app, runtime, _, _, _ = app_for()
    with TestClient(app) as client, pytest.raises(WebSocketDisconnect) as denied:
        with client.websocket_connect(f"/runtime/v1/endpoints/{endpoint}/guardrails/output-stream",
                                      headers={"x-api-key": credential, "x-tenant": "tenantA"}):
            pass
    assert denied.value.code == code
    assert runtime.calls == []


@pytest.mark.parametrize("change", [{"capacity": True}, {"max_queued": -1}, {"tenant_limits": {}},
    {"tenant_limits": {" tenantA": 1}}, {"tenant_limits": {"tenantA": False}},
    {"tenant_limits": {"x" * 257: 1}}, {"tenant_limits": {"bad\ud800": 1}},
    {"tenant_limits": {f"tenant{i}": 1 for i in range(1001)}},
    {"queue_timeout_seconds": float("nan")}, {"queue_timeout_seconds": 31}, {"extra": 1}])
def test_admission_configuration_rejects_ambiguous_or_unbounded_values(change):
    values = dict(capacity=2, tenant_limits={"tenantA": 1}, max_queued=2, max_queued_per_tenant=1, queue_timeout_seconds=0.1)
    with pytest.raises(ValueError):
        TenantAdmissionConfiguration.from_json(json.dumps({**values, **change}))


def test_duplicate_tenant_configuration_is_rejected():
    with pytest.raises(ValueError, match="duplicate"):
        TenantAdmissionConfiguration.from_json('{"capacity":2,"tenant_limits":{"tenantA":1,"tenantA":2},"max_queued":1,"max_queued_per_tenant":1,"queue_timeout_seconds":0.1}')


class RejectingRate:
    def __init__(self, error):
        self.error = error
        self.tenants = []

    async def admit(self, tenant):
        self.tenants.append(tenant)
        raise self.error


@pytest.mark.asyncio
@pytest.mark.parametrize("error,status", [(AdmissionRejected("rate_limited", retry_after=7), 429),
                                         (AdmissionUnavailable("Redis unavailable"), 503)])
async def test_distributed_gate_http_and_scan_errors_release_local_slot(error, status):
    rate = RejectingRate(error)
    app, runtime, _, local, _ = app_for(rate=rate)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        assert (await request(client, **{"x-api-key": "invalid"})).status_code == 401
        assert (await client.post("/runtime/v1/endpoints/a/verify", headers={"x-api-key": "key-a"})).status_code == 200
        response = await request(client, **{"x-tenant-id": "tenantB"})
        assert response.status_code == status
        assert response.headers["retry-after"] == ("7" if status == 429 else "1")
        scan = await client.post("/runtime/v1/endpoints/scan-a/backend/v1/scans",
            headers={"authorization": "Bearer key-scan-a"}, json={"input": "hello"})
        assert scan.status_code == status and scan.headers["retry-after"] == response.headers["retry-after"]
        assert scan.json()["detail"]["code"].startswith("tenant_admission_")
    assert rate.tenants == ["tenantA", "tenantA"] and runtime.calls == [] and local._active_total == 0


@pytest.mark.parametrize("error", [AdmissionRejected("rate_limited"), AdmissionUnavailable("Redis unavailable")])
def test_distributed_gate_websocket_rejects_before_accept_and_releases(error):
    rate = RejectingRate(error)
    app, runtime, _, local, _ = app_for(rate=rate)
    with TestClient(app) as client, pytest.raises(WebSocketDisconnect) as denied:
        with client.websocket_connect("/runtime/v1/endpoints/a/guardrails/output-stream",
            headers={"x-api-key": "key-a", "x-tenant-id": "tenantB"}):
            pass
    assert denied.value.code == 1013 and rate.tenants == ["tenantA"]
    assert runtime.calls == [] and local._active_total == 0
