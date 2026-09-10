"""Fault an actual Action behind frozen signed bytes, never mock its verdict."""
import asyncio
from functools import wraps

import httpx
import pytest
from fastapi import FastAPI

from runner.api import RunnerAPI
from runner.metrics import RunnerMetrics
from runner.toolkit.nemo.runtime import NeMoActionBridge
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import _runtime, RUNTIME_CREDENTIAL, Telemetry
from tests.data_plane.test_custom_symbol_artifact import FIXTURE


@pytest.fixture
def broken_action(monkeypatch, error_type):
    original = NeMoActionBridge.record_owned_policy
    calls = []

    @wraps(original)
    async def execute(self, *args, **kwargs):
        calls.append(kwargs["policy_id"])
        if kwargs["text"] == "check":
            if error_type == "invalid_result":
                # Simulate a decoder passing through a string, then execute
                # the actual recording Action and its real contract checks.
                kwargs["safe"] = "false"
            else:
                raise error_type("sensitive-exception-detail-must-not-leak")
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(NeMoActionBridge, "record_owned_policy", execute)
    return calls


@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("error_type", [RuntimeError, TimeoutError, "invalid_result"])
async def test_real_action_failure_is_terminal_and_request_scoped(tmp_path, broken_action, phase, caplog, error_type):
    store, _registry, engine = _runtime(tmp_path, FIXTURE)
    runtime = GuardrailRuntimeService(engine, store)
    async def evaluate(text):
        return await runtime.evaluate(ProtectionRequest(phase=phase, texts=(text,),
            context=RequestContext(protocol="litellm", endpoint_id="fixture-endpoint")))
    try:
        failure = await evaluate("check")
        assert failure.decision == "block" and failure.usage.fail_closed
        assert broken_action == ["policy-a"]  # No later Policy Action executes.
        assert "GuardRecordOwnedPolicyAction" in failure.reason
        assert any(step.timed_out for step in failure.trace) is (error_type is TimeoutError)
        assert "sensitive-exception-detail" not in str(failure)
        bad, good = await asyncio.gather(evaluate("check"), evaluate("ordinary"))
        assert bad.usage.fail_closed and bad.decision == "block"
        assert not good.usage.fail_closed and good.decision == "allow"
        assert not (await evaluate("ordinary")).usage.fail_closed
        assert "sensitive-exception-detail" not in caplog.text
    finally:
        await engine.shutdown()


@pytest.mark.parametrize("error_type", [RuntimeError, TimeoutError, "invalid_result"])
async def test_real_action_failure_does_not_release_buffered_http_stream(tmp_path, broken_action, error_type):
    store, _registry, engine = _runtime(tmp_path, FIXTURE)
    app = FastAPI()
    app.include_router(RunnerAPI(GuardrailRuntimeService(engine, store), store, RunnerMetrics(4),
        Telemetry(), "fixture-runner", "controller-token").router)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
            async def send(sequence, text, final):
                return await client.post("/runtime/v1/endpoints/fixture-endpoint/guardrails/output-stream",
                    headers={"x-api-key": RUNTIME_CREDENTIAL}, json={"stream_id": "action-failure",
                        "sequence": sequence, "text": text, "final": final, "protocol": "litellm"})
            first = await send(0, "ch", False)
            assert first.status_code == 200
            assert first.json()["released_text"] == ""
            last = await send(1, "eck", True)
            expected_status = 504 if error_type is TimeoutError else 502
            assert last.status_code == expected_status, last.text
            assert "released_text" not in last.json()
            assert "sensitive-exception-detail" not in last.text
            retry = await send(1, "eck", True)
            assert retry.status_code == expected_status, retry.text
            # Failed chunks are not committed: retry evaluates the exact same
            # accumulated candidate, and must fail again without releasing it.
            assert broken_action == ["policy-a", "policy-a"]
    finally:
        await engine.shutdown()
