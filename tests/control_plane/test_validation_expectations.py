from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from runner.compiler import DefaultRunnerCompiler
from runner.protocol_codec import validation_test_from_proto, validation_test_to_proto
from runner.serialization import plan_from_dict
from runner.toolkit.runtime.contracts import ProtectionDecision, RiskFinding, RuntimeUsage
from runner.validator import DefaultRunnerValidator


def declared_plan(policies, *, bindings=None, phase="input"):
    """Give mocked findings real, pinned, executable Rule identities."""
    return plan_from_dict({
        "guardrail_id": "test", "guardrail_version": "20260904-010000.001Z",
        "policy_bindings": bindings if bindings is not None else [
            {"policy_id": policy, "policy_version": "1", "enabled_rule_ids": rules,
             "enabled_rails": [phase]} for policy, rules in policies.items()],
        "steps": [{"id": f"{policy}:{rule}", "capability": "builtin_content_filter",
                   "contract_ref": "test", "phases": [phase], "on_unsafe": "block",
                   "parameters": [["policy_id", policy], ["rule_id", rule]]}
                  for policy, rules in policies.items() for rule in rules],
    })


@pytest.mark.parametrize("change", ["none", "missing_finding", "reject_binding", "changed_output", "wrong_rule", "stale", "unknown"])
async def test_observation_only_override_preserves_detection_and_pass_action(change):
    text = "You should report any failure honestly."
    case = {
        "id": "observe", "content": text, "phase": "input", "expectedDecision": "block",
        "sourcePolicyId": "insults", "sourcePolicyVersion": "1", "sourceCaseId": "insults-case",
        "coveredRuleIds": ["insults-rule"],
        "expectationOverride": {"sourcePolicyVersion": "old" if change == "stale" else "1",
            "reason": "Reviewed observation-only action with retained evidence.", "expectedDecision": "allow",
            "expectedOutputContent": text, "expectedMatches": [{"policyId": "insults", "ruleId": "insults-rule"}]},
    }
    findings = () if change == "missing_finding" else (RiskFinding(
        risk="builtin_content_filter", taxonomy_id="TALI-SOCIAL-HARM-HARASSMENT", verdict="unknown" if change == "unknown" else "matched", confidence=1,
        evidence="Synthetic insults match", recommended_action="allow", policy_id="insults",
        rule_id="wrong" if change == "wrong_rule" else "insults-rule",
    ),)
    runtime = AsyncMock()
    runtime.evaluate.return_value = ProtectionDecision(decision="allow", action="allow", findings=findings,
        texts=("changed",) if change == "changed_output" else ())
    plan = declared_plan({"insults": ["insults-rule"]}, bindings=[{"policy_id": "insults", "policy_version": "1", "enabled_rule_ids": ["insults-rule"],
            "rule_actions": [["insults-rule", "block" if change == "reject_binding" else "allow"]], "enabled_rails": ["input"]}])
    result = await DefaultRunnerValidator(DefaultRunnerCompiler())._evaluate(runtime, plan, case)
    assert result["passed"] is (change == "none"), result


def test_legacy_numeric_guardrail_versions_are_rejected():
    with pytest.raises(ValueError, match="canonical UTC timestamp"):
        plan_from_dict({"guardrail_id": "legacy", "guardrail_version": 1})


async def test_unclassified_runtime_failure_is_not_a_successful_block_test():
    runtime = AsyncMock()
    runtime.evaluate.return_value = ProtectionDecision(decision="block", action="block",
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
        decision="transform", action="transform", texts=(output,), findings=(RiskFinding(
            risk="pii", taxonomy_id="pii", verdict="matched", confidence=1,
            evidence="Synthetic complete-ID detector.", recommended_action="transform",
            policy_id="earlier", rule_id=rule,
        ),),
    )
    plan = declared_plan({"pattern": ["later-id"], "earlier": ["complete-id"]})
    decoded = validation_test_from_proto(validation_test_to_proto(case))
    result = await DefaultRunnerValidator(DefaultRunnerCompiler())._evaluate(runtime, plan, decoded)
    assert result["passed"] is (change == "none")
    assert result["templateExpectedDecision"] == original["expectedDecision"]
    assert result["sourcePolicyId"] == original["sourcePolicyId"]
    assert result["coveredRuleIds"] == original["coveredRuleIds"]
    if change == "partial_output":
        assert any("complete-output" in failure for failure in result["assertionFailures"])


# Another Rule may explain the final decision but cannot prove target acceptance.
@pytest.mark.parametrize("scenario", [
    "earlier_policy", "earlier_rule", "later_policy", "later_rule",
    "disabled_rule", "wrong_phase", "stale_target", "unknown_policy",
    "no_evidence", "unknown_verdict", "fail_closed", "redaction", "expected_allow",
    "target_already_ran", "reviewed_override",
])
async def test_schedule_independent_case_evidence(scenario):
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
    action = "transform" if scenario == "redaction" else "block"
    findings = () if scenario == "no_evidence" else (RiskFinding(
        risk="builtin_content_filter", taxonomy_id="test", verdict="unknown" if scenario == "unknown_verdict" else "matched", confidence=1,
        evidence="Ordered terminal detector", recommended_action=action,
        policy_id=blocker, rule_id="blocker",
    ),)
    runtime = AsyncMock()
    runtime.evaluate.return_value = ProtectionDecision(
        decision="transform" if scenario == "redaction" else "block", action=action,
        findings=findings, usage=RuntimeUsage(fail_closed=scenario == "fail_closed"),
        trace=(RuntimeTraceStep(id="nemo:action:target:covered", kind="action", name="target", detail="Target ran", policy_id=source, status="passed", verdict="not_matched"),) if scenario == "target_already_ran" else (),
    )
    plan = declared_plan({"earlier": ["blocker"], "target": ["covered", "blocker"]}, bindings=bindings)
    case = {"id": "source-case", "expectedDecision": "allow" if scenario == "expected_allow" else "transform" if scenario == "redaction" else "block",
        "phase": "input", "content": "overlapping detection", "sourcePolicyId": source,
        "sourcePolicyVersion": "1", "coveredRuleIds": ["covered"], "caseType": "rule_acceptance"}
    if scenario == "reviewed_override":
        case["expectationOverride"] = {"sourcePolicyVersion": "1", "reason": "Require target evidence", "expectedDecision": "block", "expectedMatches": [{"policyId": source, "ruleId": "covered"}]}
    result = await DefaultRunnerValidator(DefaultRunnerCompiler())._evaluate(runtime, plan, case)
    assert result["passed"] is False
    assert result["preemptingMatches"] == []
    assert result["verifiedRuleIds"] == []
    assert "covered" not in result["matchedRuleIds"]
    if scenario == "target_already_ran":
        assert result["evidenceStatus"] == "not_matched"
        assert "ran but did not match" in result["reason"]
    elif scenario in {"earlier_policy", "earlier_rule", "later_policy", "later_rule"}:
        assert result["evidenceStatus"] == "preempted_by"
        assert result["supersededBy"] == [{"policyId": blocker, "ruleId": "blocker"}]
    wire = validation_case_result_to_proto(result)
    assert not wire.rule_contract_satisfied
    assert wire.evidence_contract == "rule-evidence-v1"
    assert len(wire.preempting_matches) == 0


@pytest.mark.parametrize("reverse", [False, True])
def test_programmable_rule_evidence_is_independent_of_flow_order(reverse):
    """A custom Colang Policy resolves its covered Rule by identity, not position."""
    from dataclasses import replace
    from runner.toolkit.runtime.contracts import PolicyVersionSnapshot, PolicyRailBindingSnapshot
    from runner.validator import _case_evidence, _rule_target

    binding = {"policy_id": "custom", "policy_version": "7", "enabled_rule_ids": ["flow/input/target", "flow/input/first"], "enabled_rails": ["input"],
               "rule_order": ["flow/input/target"] if reverse else []}
    plan = plan_from_dict({"guardrail_id": "ordered", "guardrail_version": "20260904-010000.001Z", "policy_bindings": [binding]})
    rails = [PolicyRailBindingSnapshot(rail_type="input", flow_name=name, execution_mode="detect", on_unsafe="block")
             for name in (["target", "first"] if reverse else ["first", "target"])]
    plan = replace(plan, policy_versions=(PolicyVersionSnapshot(policy_id="custom", version="7", name="Custom", source="custom",
        colang_version="2.x", sources=(), parameter_schema=(), rail_bindings=tuple(rails), action_references=(),
        evaluation_contracts=(), prompt_dependencies=(), execution_contract=(), test_cases=(), checksum="pinned"),))
    resolved = _rule_target(plan, "custom", "flow/input/target", "input")
    assert resolved is not None and resolved["bindingId"] == "tl.custom.v7.target"
    evidence = _case_evidence(
        plan,
        {"sourcePolicyId": "custom", "sourcePolicyVersion": "7", "coveredRuleIds": ["flow/input/target"]},
        "input", "block", SimpleNamespace(decision="block"),
        [{"policy_id": "custom", "rule_id": "flow/input/first", "verdict": "matched", "recommended_action": "block"}],
        [], "overlapping detection",
    )
    assert evidence["status"] == "preempted_by" and evidence["satisfied"] is False


@pytest.mark.parametrize("verdict", ["matched", "unknown", "error"])
@pytest.mark.parametrize("override", [False, True])
async def test_inconclusive_result_is_not_detection_evidence(verdict, override):
    runtime = AsyncMock()
    runtime.evaluate.return_value = ProtectionDecision(decision="block", action="block", findings=(
        RiskFinding(risk="contextual_grounding", taxonomy_id="test", verdict=verdict,
            confidence=0, evidence="Synthetic detector result", recommended_action="block",
            policy_id="grounding", rule_id="judge"),))
    plan = declared_plan({"grounding": ["judge"]}, phase="output")
    case = {"id": "unsupported", "content": "A response", "phase": "output", "expectedDecision": "block",
        "caseType": "rule_acceptance", "sourcePolicyId": "grounding", "sourcePolicyVersion": "1",
        "coveredRuleIds": ["judge"]}
    if override:
        case["expectationOverride"] = {"sourcePolicyVersion": "1", "reason": "Require detector evidence",
            "expectedDecision": "block", "expectedMatches": [{"policyId": "grounding", "ruleId": "judge"}]}
    result = await DefaultRunnerValidator(DefaultRunnerCompiler())._evaluate(runtime, plan, case)
    assert result["passed"] is (verdict == "matched")
    assert result["matchedRuleIds"] == (["judge"] if verdict == "matched" else [])
    if verdict != "matched":
        assert "Expected Policy/Rule evidence was not observed." in result["assertionFailures"]


async def test_missing_context_can_be_tested_as_a_boundary_without_claiming_a_match():
    runtime = AsyncMock()
    runtime.evaluate.return_value = ProtectionDecision(decision="block", action="block", findings=(
        RiskFinding(risk="contextual_grounding", taxonomy_id="test", verdict="unknown", confidence=0,
            evidence="Missing query", recommended_action="block", policy_id="grounding", rule_id="judge"),))
    plan = declared_plan({"grounding": ["judge"]}, phase="output")
    result = await DefaultRunnerValidator(DefaultRunnerCompiler())._evaluate(runtime, plan,
        {"id": "missing-query", "content": "A response", "phase": "output", "expectedDecision": "block", "caseType": "scenario"})
    assert result["passed"]
    assert result["matchedRuleIds"] == []


@pytest.mark.parametrize("change,status", [
    ("missing_policy", "missing"), ("stale", "missing"), ("phase", "missing"),
    ("disabled", "missing"), ("omitted", "missing"), ("unidentified", "unverifiable"),
    ("partial", "not_reached"), ("not_run", "not_reached"), ("ran", "absent"),
])
async def test_every_covered_rule_needs_a_pinned_executable_target_and_conclusive_result(change, status):
    from runner.toolkit.runtime.contracts import RuntimeTraceStep
    plan = declared_plan({"target": ["a", "b"]})
    from dataclasses import replace
    if change == "missing_policy": plan = replace(plan, policy_bindings=())
    elif change == "stale": plan = replace(plan, policy_bindings=(replace(plan.policy_bindings[0], policy_version="2"),))
    elif change == "phase": plan = replace(plan, policy_bindings=(replace(plan.policy_bindings[0], enabled_rails=("output",)),))
    elif change == "disabled": plan = replace(plan, policy_bindings=(replace(plan.policy_bindings[0], enabled_rule_ids=("a",)),))
    elif change == "omitted": plan = replace(plan, steps=plan.steps[:1])
    negative = change in {"ran", "not_run"}
    case = {"id": "both", "content": "sample", "phase": "input", "expectedDecision": "allow" if negative else "block",
            "sourcePolicyId": "target", "sourcePolicyVersion": "1", "coveredRuleIds": ["a", "b"]}
    if change == "unidentified": del case["sourcePolicyId"]
    findings = () if negative else tuple(RiskFinding(risk="test", taxonomy_id="test", verdict="matched", confidence=1,
        evidence="Observed", recommended_action="block", policy_id="target", rule_id=rule)
        for rule in (["a"] if change == "partial" else ["a", "b"]))
    runtime = AsyncMock()
    runtime.evaluate.return_value = ProtectionDecision(decision=case["expectedDecision"], action=case["expectedDecision"], findings=findings,
        trace=tuple(RuntimeTraceStep(id=f"nemo:action:target:{rule}", kind="action", name=rule, detail="Ran", verdict="not_matched", status="passed")
                    for rule in ("a", "b")) if change == "ran" else ())
    result = await DefaultRunnerValidator(DefaultRunnerCompiler())._evaluate(runtime, plan, case)
    assert result["passed"] is (change == "ran")
    assert result["evidenceStatus"] == ("preempted_by" if change == "partial" else status)


def test_grouped_legacy_action_match_does_not_prove_every_rule_executed():
    from dataclasses import replace
    from runner.validator import _case_evidence
    plan = declared_plan({"target": ["first", "second"]})
    grouped = replace(plan.steps[0], parameters=(("policy_id", "target"),
                      ("enabled_rules_json", '{"target":["first","second"]}')))
    plan = replace(plan, steps=(grouped,))
    evidence = _case_evidence(plan, {"sourcePolicyId": "target", "sourcePolicyVersion": "1", "coveredRuleIds": ["second"]},
        "input", "block", SimpleNamespace(decision="block"),
        [{"policy_id": "target", "rule_id": "first", "verdict": "matched", "recommended_action": "block"}],
        [], "content", trace=[{"id": "nemo:action:target:first", "verdict": "matched"}])
    assert evidence["status"] == "preempted_by"
    assert not evidence["satisfied"]


@pytest.mark.parametrize("omit_step", [False, True])
def test_catalog_native_sole_rule_uses_the_runtime_identity_contract(omit_step):
    from dataclasses import replace
    from runner.validator import _case_evidence
    plan = declared_plan({"native": ["boundary/rule"]})
    step = replace(plan.steps[0], capability="indirect_prompt_injection", contract_ref="tali.guard.indirect-prompt-injection.v1",
                   parameters=(("policy_id", "native"), ("policy_version", "1")))
    plan = replace(plan, steps=() if omit_step else (step,))
    evidence = _case_evidence(plan, {"sourcePolicyId": "native", "sourcePolicyVersion": "1", "coveredRuleIds": ["boundary/rule"]},
        "input", "block", SimpleNamespace(decision="block"),
        [{"policy_id": "native", "rule_id": "boundary/rule", "verdict": "matched", "recommended_action": "block"}],
        ["boundary/rule"], "content")
    assert evidence["satisfied"] is not omit_step
    assert evidence["status"] == ("missing" if omit_step else "observed")


async def test_reviewed_negative_expectation_cannot_turn_unexecuted_rules_into_absence():
    runtime = AsyncMock()
    runtime.evaluate.return_value = ProtectionDecision(decision="allow", action="allow")
    plan = declared_plan({"target": ["rule"]})
    result = await DefaultRunnerValidator(DefaultRunnerCompiler())._evaluate(runtime, plan, {
        "id": "negative", "content": "ordinary", "phase": "input", "expectedDecision": "allow",
        "sourcePolicyId": "target", "sourcePolicyVersion": "1", "coveredRuleIds": ["rule"],
        "expectationOverride": {"reason": "Reviewed negative case", "sourcePolicyVersion": "1", "expectedDecision": "allow", "expectedMatches": []},
    })
    assert not result["passed"]
    assert result["evidenceStatus"] == "not_reached"
    assert not result["ruleContractSatisfied"]


@pytest.mark.parametrize("kind,matched_policy,passed", [("scenario", "target", True), ("rule_acceptance", "target", False), ("scenario", "other", False)])
async def test_scenario_alternatives_need_actual_source_evidence_but_do_not_certify_every_rule(kind, matched_policy, passed):
    plan = declared_plan({"target": ["bearer", "private-key"], "other": ["bearer"]})
    runtime = AsyncMock()
    runtime.evaluate.return_value = ProtectionDecision(decision="block", action="block", findings=(RiskFinding(
        risk="test", taxonomy_id="test", verdict="matched", confidence=1, evidence="Actual bearer token match",
        recommended_action="block", policy_id=matched_policy, rule_id="bearer"),))
    result = await DefaultRunnerValidator(DefaultRunnerCompiler())._evaluate(runtime, plan, {
        "id": "credential-kinds", "content": "token", "phase": "input", "expectedDecision": "block", "caseType": kind,
        "sourcePolicyId": "target", "sourcePolicyVersion": "1", "coveredRuleIds": ["bearer", "private-key"],
    })
    assert result["passed"] is passed
    assert result["verifiedRuleIds"] == (["bearer"] if matched_policy == "target" else [])


@pytest.mark.parametrize("final_verdict,executed,passed", [("not_matched", True, True), ("unknown", True, False), ("not_matched", False, False)])
async def test_native_rule_negative_evidence_uses_its_completed_escalation(final_verdict, executed, passed):
    from dataclasses import replace
    from runner.toolkit.runtime.contracts import RuntimeTraceStep, EvaluationTrigger
    plan = declared_plan({"native": ["rule"]})
    exact = replace(plan.steps[0], id="exact", capability="pii", parameters=(("policy_id", "native"), ("policy_version", "1")))
    semantic = replace(exact, id="semantic", trigger=EvaluationTrigger(type="on_result", step_ref="exact", verdicts=("unknown",)))
    plan = replace(plan, steps=(exact, semantic))
    trace = [RuntimeTraceStep(id="nemo:action:exact", kind="action", name="Exact", detail="Escalate", status="needs_context", verdict="unknown")]
    if executed:
        trace.append(RuntimeTraceStep(id="nemo:action:semantic", kind="action", name="Semantic", detail="Completed", status="passed", verdict=final_verdict))
    runtime = AsyncMock()
    runtime.evaluate.return_value = ProtectionDecision(decision="allow", action="allow", trace=tuple(trace))
    result = await DefaultRunnerValidator(DefaultRunnerCompiler())._evaluate(runtime, plan, {
        "id": "native-negative", "phase": "input", "content": "ordinary", "expectedDecision": "allow",
        "sourcePolicyId": "native", "sourcePolicyVersion": "1", "coveredRuleIds": ["rule"],
    })
    assert result["passed"] is passed
    assert result["evidenceStatus"] == ("absent" if passed else "not_reached")
