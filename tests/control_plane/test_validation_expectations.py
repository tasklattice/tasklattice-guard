from __future__ import annotations

from copy import deepcopy
from unittest.mock import AsyncMock

import pytest

from runner.compiler import DefaultRunnerCompiler
from runner.protocol_codec import validation_test_from_proto, validation_test_to_proto
from runner.serialization import plan_from_dict
from runner.toolkit.runtime.contracts import ProtectionDecision, RiskFinding, RuntimeUsage
from runner.validator import DefaultRunnerValidator


def test_legacy_numeric_guardrail_versions_are_rejected():
    with pytest.raises(ValueError, match="canonical UTC timestamp"):
        plan_from_dict({"guardrail_id": "legacy", "guardrail_version": 1})


async def test_unclassified_runtime_failure_is_not_a_successful_block_test():
    runtime = AsyncMock()
    runtime.evaluate.return_value = ProtectionDecision(decision="block", action="reject",
        usage=RuntimeUsage(fail_closed=True))
    plan = plan_from_dict({"guardrail_id": "test", "guardrail_version": "20260904-010000.001Z",
        "compiler_version": "test", "steps": [], "modules": []})
    result = await DefaultRunnerValidator(DefaultRunnerCompiler())._evaluate(runtime, plan,
        {"id": "block", "content": "ordinary", "phase": "output", "expectedDecision": "block", "required": True})
    assert not result["passed"]
    assert any("not a Policy match" in item for item in result["assertionFailures"])


@pytest.mark.parametrize("change", ["none", "partial_output", "wrong_rule", "stale", "unreviewed"])
async def test_composition_assertions_require_reviewed_evidence_and_complete_output(change):
    case = {
        "id": "inherited", "name": "Complete ID redaction", "policyId": "pattern",
        "phase": "input", "content": "ID: 784-1990-1234567-1",
        "expectedDecision": "transform", "required": True,
        "sourcePolicyId": "pattern", "sourcePolicyVersion": "1", "sourceCaseId": "id-case",
        "coveredRuleIds": ["later-id"],
        "expectationOverride": {
            "sourcePolicyVersion": "1", "reason": "Earlier Policy fully redacts the same ID.",
            "expectedDecision": "transform", "expectedOutputContent": "ID: [REDACTED]",
            "expectedMatches": [{"policyId": "earlier", "ruleId": "complete-id"}],
        },
    }
    original = deepcopy(case)
    output = "ID: 784-[REDACTED]-1" if change == "partial_output" else "ID: [REDACTED]"
    rule = "wrong" if change == "wrong_rule" else "complete-id"
    if change == "stale":
        case["expectationOverride"]["sourcePolicyVersion"] = "old"
    if change == "unreviewed":
        case["expectationOverride"]["reason"] = ""
    # A mock execution response isolates Validator assertions from compilation
    # and detection. In particular, partial_output has the RIGHT Rule and final
    # decision but still must fail the output-content contract.
    runtime = AsyncMock()
    runtime.evaluate.return_value = ProtectionDecision(
        decision="transform", action="redact", texts=(output,), findings=(RiskFinding(
            risk="pii", taxonomy_id="pii", verdict="unsafe", confidence=1,
            evidence="Synthetic complete-ID detector.", recommended_action="redact",
            policy_id="earlier", rule_id=rule,
        ),),
    )
    plan = plan_from_dict({
        "guardrail_id": "test", "guardrail_version": "20260904-010000.001Z", "compiler_version": "test",
        "safety_level": "balanced", "output_delivery": "full_buffered",
        "steps": [], "modules": [],
    })
    decoded = validation_test_from_proto(validation_test_to_proto(case))
    result = await DefaultRunnerValidator(DefaultRunnerCompiler())._evaluate(runtime, plan, decoded)
    assert result["passed"] is (change == "none")
    assert result["templateExpectedDecision"] == original["expectedDecision"]
    assert result["sourcePolicyId"] == original["sourcePolicyId"]
    assert result["coveredRuleIds"] == original["coveredRuleIds"]
    if change == "partial_output":
        assert any("complete-output" in failure for failure in result["assertionFailures"])


@pytest.mark.parametrize("scenario,passed", [
    ("earlier_policy", True), ("earlier_rule", True), ("later_policy", False),
    ("later_rule", False), ("disabled_rule", False), ("wrong_phase", False),
    ("stale_target", False), ("unknown_policy", False), ("no_evidence", False),
    ("fail_closed", False), ("redaction", False), ("expected_allow", False),
    ("target_already_ran", False), ("reviewed_override", False),
])
async def test_ordered_terminal_preemption(scenario, passed):
    from runner.toolkit.runtime.contracts import RuntimeTraceStep
    from runner.protocol_codec import validation_case_result_to_proto

    source = "target"
    blocker = "earlier"
    bindings = [
        {"policy_id": "earlier", "policy_version": "1", "enabled_rule_ids": ["blocker"], "enabled_rails": ["input"]},
        {"policy_id": "target", "policy_version": "1", "enabled_rule_ids": ["covered"], "enabled_rails": ["input"]},
    ]
    if scenario in {"earlier_rule", "later_rule"}:
        blocker = source
        bindings[1]["enabled_rule_ids"] = ["covered", "blocker"]
        bindings[1]["rule_order"] = ["blocker", "covered"] if scenario == "earlier_rule" else ["covered", "blocker"]
    if scenario == "later_policy":
        bindings.reverse()
    if scenario == "disabled_rule":
        bindings[0]["enabled_rule_ids"] = []
    if scenario == "wrong_phase":
        bindings[0]["enabled_rails"] = ["output"]
    if scenario == "stale_target":
        bindings[1]["policy_version"] = "2"
    if scenario == "unknown_policy":
        blocker = "unknown"
    action = "redact" if scenario == "redaction" else "reject"
    findings = () if scenario == "no_evidence" else (RiskFinding(
        risk="builtin_content_filter", taxonomy_id="test", verdict="unsafe", confidence=1,
        evidence="Ordered terminal detector", recommended_action=action,
        policy_id=blocker, rule_id="blocker",
    ),)
    runtime = AsyncMock()
    runtime.evaluate.return_value = ProtectionDecision(
        decision="transform" if scenario == "redaction" else "block", action=action,
        findings=findings, usage=RuntimeUsage(fail_closed=scenario == "fail_closed"),
        trace=(RuntimeTraceStep(id="target-action", kind="action", name="target", detail="Target ran", policy_id=source, status="safe"),) if scenario == "target_already_ran" else (),
    )
    plan = plan_from_dict({"guardrail_id": "ordered", "guardrail_version": "20260904-010000.001Z", "policy_bindings": bindings})
    case = {"id": "source-case", "expectedDecision": "allow" if scenario == "expected_allow" else "transform" if scenario == "redaction" else "block",
        "phase": "input", "content": "overlapping detection", "sourcePolicyId": source,
        "sourcePolicyVersion": "1", "coveredRuleIds": ["covered"], "caseType": "rule_acceptance"}
    if scenario == "reviewed_override":
        case["expectationOverride"] = {"sourcePolicyVersion": "1", "reason": "Require target evidence", "expectedDecision": "block", "expectedMatches": [{"policyId": source, "ruleId": "covered"}]}
    result = await DefaultRunnerValidator(DefaultRunnerCompiler())._evaluate(runtime, plan, case)
    assert result["passed"] is passed
    assert bool(result["preemptingMatches"]) is passed
    assert "covered" not in result["matchedRuleIds"]
    wire = validation_case_result_to_proto(result)
    assert len(wire.preempting_matches) == (1 if passed else 0)


@pytest.mark.parametrize("reverse", [False, True])
def test_custom_policy_preemption_uses_pinned_flow_order(reverse):
    from dataclasses import replace
    from runner.toolkit.runtime.contracts import PolicyVersionSnapshot, PolicyRailBindingSnapshot
    from runner.validator import _ordered_preemption

    binding = {"policy_id": "custom", "policy_version": "7", "enabled_rule_ids": ["flow/input/target", "flow/input/first"], "enabled_rails": ["input"],
               "rule_order": ["flow/input/target"] if reverse else []}
    plan = plan_from_dict({"guardrail_id": "ordered", "guardrail_version": "20260904-010000.001Z", "policy_bindings": [binding]})
    version = PolicyVersionSnapshot(policy_id="custom", version="7", name="Custom", source="custom", colang_version="2.x",
        sources=(), parameter_schema=(), rail_bindings=tuple(PolicyRailBindingSnapshot(rail_type="input", flow_name=name,
            execution_mode="detect", on_unsafe="reject") for name in ["first", "target"]),
        action_references=(), evaluation_contracts=(), prompt_dependencies=(), execution_contract=(), test_cases=(), checksum="pinned")
    plan = replace(plan, policy_versions=(version,))
    result = _ordered_preemption(plan, {"sourcePolicyId": "custom", "sourcePolicyVersion": "7", "coveredRuleIds": ["flow/input/target"]}, "input",
        [{"policy_id": "custom", "rule_id": "flow/input/first", "verdict": "unsafe", "recommended_action": "reject"}], [])
    assert bool(result) is (not reverse)
