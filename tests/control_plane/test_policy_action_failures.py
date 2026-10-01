"""Real NeMo dispatch must not convert an Action exception into a safe verdict."""
import pytest

from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from tests.control_plane.test_custom_policy_dependencies import custom_plan


@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("call,reference", [
    ('GuardRecordPolicyAction(flow_name="check", text=$text)', 'GuardRecordPolicyAction'),
    ('GuardRecordPolicyAction(flow_name="check", safe=True, text=$text, extra=True)', 'GuardRecordPolicyAction'),
    ('GuardCustomerIdentifierAction(text=None)', 'GuardCustomerIdentifierAction'),
    ('GuardRecordPolicyAction(flow_name="check", safe="false", text=$text)', 'GuardRecordPolicyAction'),
    ('GuardRecordPolicyAction(flow_name="check", safe=1, text=$text)', 'GuardRecordPolicyAction'),
    ('GuardRecordPolicyAction(flow_name="check", safe=None, text=$text)', 'GuardRecordPolicyAction'),
    ('GuardRecordPolicyAction(flow_name="check", safe=True, text=None)', 'GuardRecordPolicyAction'),
    ('GuardRecordPolicyAction(flow_name="check", safe=False, text=$text, replacement=42)', 'GuardRecordPolicyAction'),
])
async def test_action_dispatch_and_body_errors_fail_closed(phase, call, reference, caplog):
    plan = custom_plan(f'flow check $text\n  await {call}\n', [reference])
    plan["policy_versions"][0]["rail_bindings"][0]["rail_type"] = phase
    plan["policy_bindings"][0]["enabled_rails"] = [phase]
    runtime = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers())
    try:
        result = await runtime.evaluate(
            ProtectionRequest(phase=phase, texts=("private-test-marker",), context=RequestContext(protocol="test")),
            preview_id="action-errors", guardrail_id=plan["guardrail_id"], draft_revision=1,
            candidate_version=plan["guardrail_version"], plan=plan, runtime_profile="auto")
        assert result.usage.fail_closed, result
        assert result.decision == "block"
        assert any(step.status == "error" for step in result.trace)
        assert "private-test-marker" not in result.reason
        assert "private-test-marker" not in caplog.text
        assert "Guardrail Action:" in result.reason
    finally:
        await runtime.shutdown()


@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("expected_failure", [None, "provider_failure", "timeout"])
async def test_validator_requires_explicit_matching_action_failure_expectation(phase, expected_failure):
    from runner import generated as protocol
    from runner.protocol_codec import plan_to_proto, validation_test_to_proto
    from runner.validator import DefaultRunnerValidator
    plan = custom_plan('flow check $text\n  await GuardRecordPolicyAction(flow_name="check", text=$text)\n',
        ["GuardRecordPolicyAction"])
    plan["policy_versions"][0]["rail_bindings"][0]["rail_type"] = phase
    plan["policy_bindings"][0]["enabled_rails"] = [phase]
    status, _, results = await DefaultRunnerValidator(DefaultRunnerCompiler()).validate(protocol.ValidationRequest(
        run_id="action-failure", guardrail_id=plan["guardrail_id"], candidate_version=plan["guardrail_version"],
        source_draft_revision=1, plan=plan_to_proto(plan), runtime_profile="auto",
        test_cases=[validation_test_to_proto({"id": "failure", "name": "Failure classification", "phase": phase,
            "content": "ordinary", "expectedDecision": "block", "required": True,
            "expectedFailure": expected_failure})]))
    assert results[0]["actualFailure"] == "provider_failure"
    assert (status == "passed") is (expected_failure == "provider_failure")
    assert results[0]["matchedRuleIds"] == []


@pytest.mark.parametrize("phase", ["input", "output"])
async def test_false_boolean_and_empty_string_replacement_are_valid(phase):
    plan = custom_plan('flow check $text\n  await GuardRecordPolicyAction(flow_name="check", safe=False, text=$text, replacement="")\n',
        ["GuardRecordPolicyAction"])
    plan["policy_versions"][0]["rail_bindings"][0].update(rail_type=phase, on_unsafe="transform", execution_mode="mutate")
    plan["policy_bindings"][0]["enabled_rails"] = [phase]
    runtime = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers())
    try:
        result = await runtime.evaluate(
            ProtectionRequest(phase=phase, texts=("remove this",), context=RequestContext(protocol="test")),
            preview_id="empty-replacement", guardrail_id=plan["guardrail_id"], draft_revision=1,
            candidate_version=plan["guardrail_version"], plan=plan, runtime_profile="auto")
        assert not result.usage.fail_closed
        assert result.decision == "transform"
        assert result.texts == ("",)
    finally:
        await runtime.shutdown()
