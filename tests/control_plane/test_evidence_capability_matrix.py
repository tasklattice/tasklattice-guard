"""Which plans can collect complete Rule evidence, and what each scope may claim.

`evidence_scope` answers two questions at once: how much to report, and whether
execution may stop at the first Block. This suite pins the mapping between the
declared scope and the execution type, and proves that an unsupported plan never
pretends its unreached checks did not match.
"""
from __future__ import annotations

from copy import deepcopy

import pytest

from runner import generated as protocol
from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.protocol_codec import plan_to_proto, validation_test_to_proto
from runner.serialization import plan_from_dict
from runner.toolkit.compiler.semantics import collects_complete_evidence, complete_evidence_supported
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions.content_filter import ContentFilterActionProvider
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from runner.validator import DefaultRunnerValidator
from tests.control_plane.test_schedule_invariance import _controller_plans


@pytest.fixture(scope="module")
def grouped_plan() -> dict:
    """Two Block Rules share one Action, so an internal early exit is visible."""
    plan = _controller_plans()["grouped"]
    assert len(plan["steps"]) == 2
    return plan


CUSTOM_VERSION = {
    "policy_id": "custom-flow", "version": "1", "name": "Custom flow", "source": "custom",
    "colang_version": "2.x", "sources": [], "rail_bindings": [], "action_references": [],
    "checksum": "custom",
}


def variant(plan: dict, *, delivery: str = "full_buffered", custom: bool = False) -> dict:
    changed = deepcopy(plan)
    changed["output_delivery"] = delivery
    if custom:
        changed["policy_versions"] = [*changed["policy_versions"], CUSTOM_VERSION]
    return changed


CASES = [("full_buffered", False, "full", True, {"r-first", "r-second"}),
         ("full_buffered", False, "interventions", True, {"r-first"}),
         ("window_buffered", False, "full", False, {"r-first"}),
         ("full_buffered", True, "full", False, {"r-first"}),
         ("interruptible", False, "interventions", False, {"r-first"})]


@pytest.mark.parametrize(("delivery", "custom", "scope", "supported", "matched"), CASES)
async def test_only_supported_execution_types_suppress_short_circuiting(
    grouped_plan, delivery, custom, scope, supported, matched,
) -> None:
    plan = variant(grouped_plan, delivery=delivery, custom=custom)
    assert complete_evidence_supported(plan_from_dict(plan)) is supported
    assert collects_complete_evidence(scope, plan_from_dict(plan)) is (supported and scope == "full")
    runtime = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(ContentFilterActionProvider()))
    try:
        decision = await runtime.evaluate(
            ProtectionRequest(phase="input", texts=("alpha beta",), evidence_scope=scope,
                              context=RequestContext(protocol="validation")),
            preview_id=f"capability-{delivery}-{custom}-{scope}", guardrail_id=plan["guardrail_id"],
            draft_revision=1, candidate_version=plan["guardrail_version"], plan=plan, runtime_profile="auto")
    finally:
        await runtime.shutdown()
    # The Block itself never depends on how much evidence the run collects.
    assert decision.decision == "block" and not decision.usage.fail_closed
    # Both Block Rules match this input, so a missing finding means the Action
    # stopped before reaching it: exactly the early exit this matrix is about.
    assert {finding.rule_id for finding in decision.findings
            if finding.verdict == "matched" and finding.recommended_action == "block"} == matched


async def test_supported_plans_certify_every_rule_without_an_override(grouped_plan) -> None:
    plan = variant(grouped_plan)
    case = _case(grouped_plan, "both", ["r-first", "r-second"])
    result = await _validate(plan, case)
    assert result["passed"] and result["evidenceStatus"] == "observed"
    assert result["verifiedRuleIds"] == ["r-first", "r-second"]


async def test_unsupported_plans_never_fabricate_the_unreached_rule(grouped_plan) -> None:
    """An early exit is reported as unreached evidence, and a review recovers it."""
    plan = variant(grouped_plan, custom=True)
    strict = await _validate(plan, _case(grouped_plan, "both", ["r-first", "r-second"]))
    assert strict["actualDecision"] == "block"
    assert not strict["passed"]
    assert strict["evidenceStatus"] in {"not_reached", "preempted_by"}
    assert strict["verifiedRuleIds"] == ["r-first"]

    reviewed = _case(grouped_plan, "reviewed", ["r-first", "r-second"])
    reviewed["expectationOverride"] = {
        "sourcePolicyVersion": grouped_plan["policy_bindings"][0]["policy_version"],
        "reason": "Reviewed: the first Block Rule accounts for this input.",
        "expectedDecision": "block",
        "expectedMatches": [{"policyId": reviewed["sourcePolicyId"], "ruleId": "r-first"}]}
    recovered = await _validate(plan, reviewed)
    assert recovered["passed"] and recovered["ruleContractSatisfied"]
    assert recovered["matchedRuleIds"] == ["r-first"]
    assert recovered["verifiedRuleIds"] == ["r-first"]


def _case(plan: dict, case_id: str, covered: list[str]) -> dict:
    binding = plan["policy_bindings"][0]
    return {"id": case_id, "name": case_id, "phase": "input", "content": "alpha beta",
            "expectedDecision": "block", "sourcePolicyId": binding["policy_id"],
            "sourcePolicyVersion": binding["policy_version"], "policyId": binding["policy_id"],
            "coveredRuleIds": covered, "caseType": "rule_acceptance", "required": True}


async def _validate(plan: dict, case: dict) -> dict:
    outcome = await DefaultRunnerValidator(DefaultRunnerCompiler()).run(protocol.ValidationRequest(
        run_id=f"capability-{case['id']}", guardrail_id=plan["guardrail_id"],
        candidate_version=plan["guardrail_version"], plan=plan_to_proto(plan),
        test_cases=[validation_test_to_proto(case)]))
    return outcome.results[0]
