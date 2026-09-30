"""Fault an actual Action behind frozen signed bytes, never mock its verdict."""
import asyncio
from functools import wraps

import pytest

from runner.toolkit.nemo.runtime import NeMoActionBridge
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import _runtime
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
async def test_real_action_failure_does_not_release_buffered_websocket_stream(tmp_path, broken_action, error_type):
    from tests.stream_client import runner, connection, exchange, released
    async with runner(tmp_path, FIXTURE.name) as (url, _, _, _, _), connection(url) as (socket, ready):
        assert ready["mode"] == "full_buffered"
        events = await exchange(socket, ["ch", "eck"])
        assert released(events) == ""
        assert events[-1]["type"] == "error"
        assert events[-1]["code"] == ("timeout" if error_type is TimeoutError else "protection_failed")
        assert "sensitive-exception-detail" not in str(events)
        assert broken_action == ["policy-a"]  # No retry, replay or second scheduler.
