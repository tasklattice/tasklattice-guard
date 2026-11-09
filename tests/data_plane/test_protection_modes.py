"""Online mode changes never alter released artifacts or real test execution."""
import asyncio
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from runner import generated as protocol
from runner.api import RunnerAPI
from runner.metrics import RunnerMetrics
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import _runtime, _desired_state, RUNTIME_CREDENTIAL, Telemetry
from tests.stream_client import service_stream

SECRET = "api_key=abcdefghijklmnop"
CONTEXT = RequestContext(protocol="litellm", endpoint_id="fixture-endpoint")


def switch(store, mode):
    identity = store.resolve(CONTEXT).plan.guardrail_id
    store.apply_protection_modes(protocol.GuardrailProtectionState(generation=store.protection_generation + 1, modes={identity: mode}))


async def test_modes_preserve_evidence_original_content_and_version_tests(tmp_path):
    store, registry, engine = _runtime(tmp_path)
    service = GuardrailRuntimeService(engine, store)
    request = ProtectionRequest(phase="input", texts=(SECRET,), context=CONTEXT)
    plan = store.resolve(CONTEXT).plan
    try:
        assert (await service.evaluate(request)).decision == "block"
        switch(store, "monitor")
        observed = await service.evaluate(request)
        assert observed.decision == "allow" and observed.texts == () and not observed.interventions
        assert observed.protection_mode == "monitor" and observed.detection_decision == "block"
        assert observed.findings and any(f.verdict == "matched" for f in observed.findings)
        assert observed.content_results[0].text == SECRET
        assert observed.usage.rail_invocations > 0
        switch(store, "bypass")
        # Explicit evaluation is the validation/Playground path, always real.
        tested = await service.evaluate_guardrail(request, plan.guardrail_id, plan.guardrail_version)
        assert tested.decision == "block" and tested.protection_mode == "enforce"
        original_evaluate = engine.evaluate
        engine.evaluate = AsyncMock(side_effect=RuntimeError("broken detector"))
        bypassed = await service.evaluate(request)
        assert bypassed.decision == "allow" and bypassed.protection_mode == "bypass"
        assert bypassed.coverage.status == "none" and not bypassed.findings and not bypassed.assessments
        assert not bypassed.content_results[0].evaluated and bypassed.usage.rail_invocations == 0
        engine.evaluate.assert_not_called()
        switch(store, "monitor")
        failed = await service.evaluate(request)
        assert failed.decision == "allow" and failed.detection_error == "RuntimeError"
        engine.evaluate.assert_awaited_once()
        engine.evaluate = original_evaluate
        switch(store, "enforce")
        assert (await service.evaluate(request)).decision == "block"
        assert store.resolve(CONTEXT).plan == plan and store.generation == 1
    finally:
        await engine.shutdown()


@pytest.mark.parametrize("mode", ["monitor", "bypass"])
async def test_scan_and_litellm_allow_but_keep_endpoint_authorization(tmp_path, mode):
    store, _, engine = _runtime(tmp_path)
    switch(store, mode)
    telemetry = Telemetry()
    app = FastAPI()
    app.include_router(RunnerAPI(GuardrailRuntimeService(engine, store), store, RunnerMetrics(4), telemetry, "runner", "internal").router)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
            path = "/runtime/v1/endpoints/fixture-endpoint/beta/litellm_basic_guardrail_api"
            response = await client.post(path, headers={"x-api-key": RUNTIME_CREDENTIAL}, json={"input_type": "request", "texts": [SECRET]})
            assert response.status_code == 200 and response.json()["action"] == "NONE"
            assert (await client.post(path, headers={"x-api-key": "wrong"}, json={"input_type": "request", "texts": [SECRET]})).status_code == 401
            desired = _desired_state()
            desired.generation = 2
            desired.endpoints[0].adapter = "f5-scan"
            store.apply(desired)
            path = "/runtime/v1/endpoints/fixture-endpoint/backend/v1/scans"
            response = await client.post(path, headers={"Authorization": f"Bearer {RUNTIME_CREDENTIAL}"}, json={"input": SECRET, "verbose": True, "flagOnly": False})
            assert response.status_code == 200, response.text
            assert response.json()["result"]["outcome"] == "cleared"
            assert response.json()["redactedInput"] == SECRET
            assert response.json()["result"]["scannerResults"] == []
            assert (await client.post(path.replace("fixture-endpoint", "other"), headers={"Authorization": f"Bearer {RUNTIME_CREDENTIAL}"}, json={"input": SECRET})).status_code == 401
            switch(store, "enforce")
            enforced = await client.post(path, headers={"Authorization": f"Bearer {RUNTIME_CREDENTIAL}"}, json={"input": SECRET, "flagOnly": False, "protection_mode": "bypass", "mode": "bypass"})
            assert enforced.json()["result"]["outcome"] == "blocked"
        assert telemetry.events[0]["metadata"]["protectionMode"] == mode
    finally:
        await engine.shutdown()


@pytest.mark.parametrize("mode", ["monitor", "bypass"])
async def test_streams_deliver_original_chunks_and_keep_mode_until_completion(tmp_path, mode):
    store, _, engine = _runtime(tmp_path)
    switch(store, mode)
    service = GuardrailRuntimeService(engine, store)
    delivered, decisions = [], []
    async def source():
        yield "api_key="
        assert delivered == ["api_key="]  # First chunk does not wait for a detector.
        switch(store, "enforce")
        yield "abcdefghijklmnop"
    async def ready(contract, _):
        assert contract.effective_mode == "interruptible"
    async def emit(text): delivered.append(text)
    async def observe(decision): decisions.append(decision)
    try:
        result = await service.stream_output(ProtectionRequest(phase="output", texts=("",), call_id="stream", context=CONTEXT), source(), ready=ready, emit=emit, observe=observe, allow_new_output=True)
        assert result.status == "completed" and "".join(delivered) == SECRET
        assert decisions[0].protection_mode == mode and decisions[0].decision == "allow"
        assert decisions[0].detection_decision == ("block" if mode == "monitor" else None)
        result, text, _, _ = await service_stream(service, ProtectionRequest(phase="output", texts=("",), call_id="next", context=CONTEXT), [SECRET])
        assert result.status == "blocked" and text == ""
    finally:
        await engine.shutdown()


async def test_monitor_timeout_is_recorded_without_failing_scan(tmp_path):
    store, _, engine = _runtime(tmp_path)
    switch(store, "monitor")
    async def stalled(*_args, **_kwargs): await asyncio.sleep(5)
    engine.evaluate = stalled
    service = GuardrailRuntimeService(engine, store)
    try:
        result = await service.evaluate_standalone(ProtectionRequest(phase="input", texts=(SECRET,), context=CONTEXT), timeout_seconds=.1)
        assert result.decision == "allow" and result.detection_error == "TimeoutError"
    finally:
        await engine.shutdown()
