"""Runner-only execution of a frozen signed custom Policy chain, no compiler."""
from pathlib import Path

import pytest

from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import _runtime

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "artifacts" / "custom-symbol-ownership-v1"
FLOW_EVENT_FIXTURE = FIXTURE.parent / "custom-flow-events-v1"
DYNAMIC_FLOW_FIXTURE = FIXTURE.parent / "custom-dynamic-flow-events-v1"


def test_runner_without_owned_recording_support_rejects_artifact_before_serving(tmp_path, monkeypatch):
    from runner.toolkit.nemo import registry as registry_module
    from runner.toolkit.nemo.actions.names import ACTION_RECORD_OWNED_POLICY
    from runner.toolkit.compiler.domain import PlanCompilationError
    # Model an older Runner's actual executor catalog, not a mocked verdict.
    monkeypatch.delitem(registry_module._EXECUTOR_ACTION_VERSIONS, ACTION_RECORD_OWNED_POLICY)
    with pytest.raises(PlanCompilationError, match="Action providers are unavailable.*GuardRecordOwnedPolicyAction"):
        _runtime(tmp_path, FIXTURE)


@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("fixture", [FIXTURE, FLOW_EVENT_FIXTURE, DYNAMIC_FLOW_FIXTURE], ids=["flow-specs", "flow-events", "dynamic-flow-events"])
@pytest.mark.parametrize("content,decision,owners", [
    ("ordinary", "allow", []),
    ("check", "block", ["policy-a", "policy_a"]),
    ("check reviewed", "block", ["policy_a"]),
])
async def test_frozen_custom_source_keeps_literals_and_policy_ownership(tmp_path, phase, content, decision, owners, fixture):
    store, registry, engine = _runtime(tmp_path, fixture)
    runtime = GuardrailRuntimeService(engine, store)
    try:
        result = await runtime.evaluate(ProtectionRequest(phase=phase, texts=(content,),
            context=RequestContext(protocol="litellm", endpoint_id="fixture-endpoint")))
        assert registry.readiness()["ready"]
        assert result.decision == decision, result
        assert result.usage.model_invocations == 0 and not result.usage.fail_closed
        assert [item.policy_id for item in result.findings if item.verdict == "matched"] == owners
        if decision == "allow":
            assert (result.texts or (content,)) == (content,)
    finally:
        await engine.shutdown()


@pytest.mark.parametrize("fragments,decision", [(["ch", "eck"], "block"), (["ordi", "nary"], "allow")])
@pytest.mark.parametrize("fixture", [FIXTURE, FLOW_EVENT_FIXTURE, DYNAMIC_FLOW_FIXTURE], ids=["flow-specs", "flow-events", "dynamic-flow-events"])
async def test_frozen_custom_output_websocket_stream_waits_for_complete_source(tmp_path, fragments, decision, fixture):
    from tests.stream_client import runner, connection, exchange, released
    async with runner(tmp_path, fixture.name) as (url, _, _, telemetry, _), connection(url) as (socket, ready):
        assert ready["mode"] == "full_buffered"
        events = await exchange(socket, fragments)
        assert events[-1]["type"] == ("blocked" if decision == "block" else "completed")
        assert events[-1]["checks"] == 1
        assert released(events) == ("ordinary" if decision == "allow" else "")
        assert len(telemetry.events) == 1
