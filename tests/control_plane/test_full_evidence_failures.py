"""Independent evidence failures cannot invalidate a proven target Block."""
from copy import deepcopy
import json

import pytest

from runner import generated as protocol
from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.protocol_codec import plan_to_proto, validation_case_result_to_proto, validation_test_to_proto
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions.content_filter import ContentFilterActionProvider
from runner.toolkit.nemo.actions.contracts import ActionResult
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from runner.validator import DefaultRunnerValidator
from tests.control_plane.test_schedule_invariance import _controller_plans, reschedule


@pytest.fixture(scope="module")
def plans():
    return _controller_plans()


class Fault(ContentFilterActionProvider):
    def __init__(self, rule="r-second", failure="exception"):
        super().__init__()
        self.rule, self.failure = rule, failure

    async def execute(self, request):
        rules = [rule for ids in json.loads(dict(request.parameters)["enabled_rules_json"]).values() for rule in ids]
        if self.rule in rules:
            if self.failure == "verdict":
                return ActionResult("error", request.content)
            raise TimeoutError() if self.failure == "timeout" else RuntimeError()
        return await super().execute(request)


def case(plan, policy, rule, phase, **changes):
    return {"id": policy, "name": policy, "phase": phase, "content": "alpha beta", "expectedDecision": "block",
            "sourcePolicyId": policy, "sourcePolicyVersion": "1.0.0", "policyId": policy,
            "coveredRuleIds": [rule], "caseType": "rule_acceptance", "required": True, **changes}


async def validate(plan, cases, provider):
    return await DefaultRunnerValidator(DefaultRunnerCompiler(), action_providers(provider)).run(protocol.ValidationRequest(
        run_id="independent-errors", guardrail_id=plan["guardrail_id"], candidate_version=plan["guardrail_version"],
        plan=plan_to_proto(plan), test_cases=[validation_test_to_proto(item) for item in cases]))


@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("failure", ["exception", "timeout", "verdict"])
@pytest.mark.parametrize("fault_first", [False, True])
@pytest.mark.parametrize("cross_policy", [False, True])
async def test_terminal_block_and_rule_acceptance_survive_an_independent_failure(plans, phase, failure, fault_first, cross_policy):
    plan = plans[f"block-block-{str(cross_policy).lower()}"]
    target_policy, failed_policy = ("p0", "p1") if cross_policy else ("mix", "mix")
    if fault_first:
        plan = reschedule(plan, list(reversed([step["id"] for step in plan["steps"]])))
    previews = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(Fault(failure=failure)))
    try:
        result = await previews.evaluate(ProtectionRequest(phase=phase, texts=("alpha beta",), evidence_scope="full",
            context=RequestContext(protocol="validation")), preview_id="independent", guardrail_id=plan["guardrail_id"],
            draft_revision=1, candidate_version=plan["guardrail_version"], plan=plan, runtime_profile="auto")
        assert result.decision == "block" and not result.usage.fail_closed
        assert any(step.kind == "action" and step.status == "error" for step in result.trace)
        assert any(item.policy_id == target_policy and item.rule_id == "r-first"
                   and item.verdict == "matched" for item in result.findings)
    finally:
        await previews.shutdown()
    infrastructure = "timeout" if failure == "timeout" else "provider_failure"
    cases = [case(plan, target_policy, "r-first", phase), case(plan, failed_policy, "r-second", phase, id="broken"),
             case(plan, target_policy, "r-first", phase, id="scenario", caseType="scenario"),
             case(plan, target_policy, "r-first", phase, id="expected", expectedFailure=infrastructure),
             case(plan, target_policy, "r-first", phase, id="wrong-failure", expectedFailure="timeout" if infrastructure != "timeout" else "provider_failure")]
    outcome = await validate(plan, cases, Fault(failure=failure))
    target, broken, scenario, expected, wrong = outcome.results
    assert target["passed"] and target["ruleContractSatisfied"]
    assert target["actualFailure"] == infrastructure and target["evidenceStatus"] == "observed"
    assert target["verifiedRuleIds"] == ["r-first"] and target["assertionFailures"] == []
    assert "composition availability is not certified" in target["evidenceDetail"]
    wire = validation_case_result_to_proto(target)
    restored = protocol.ValidationCaseResult.FromString(wire.SerializeToString())
    assert restored.passed and restored.rule_contract_satisfied
    assert restored.actual_failure and not restored.expected_failure
    assert restored.evidence_detail == target["evidenceDetail"]
    assert not broken["passed"] and not broken["ruleContractSatisfied"]
    assert not scenario["passed"] and scenario["ruleContractSatisfied"]
    assert expected["passed"] and not wrong["passed"]
    assert outcome.metrics["passed"] == 2 and outcome.status == "failed"


@pytest.mark.parametrize("change", ["no-match", "missing", "dependent", "transformed-view", "override"])
async def test_unproven_targets_and_composition_assertions_still_fail(plans, change):
    plan = deepcopy(plans["block-block-true"])
    target = case(plan, "p0", "r-first", "input")
    if change == "no-match":
        target["content"] = "ordinary"
    elif change == "missing":
        target["coveredRuleIds"] = ["absent"]
    elif change == "dependent":
        first, second = plan["steps"][:2]
        first["trigger"] = {"type": "on_result", "step_ref": second["id"], "verdicts": ["matched"]}
        # The authored order must follow the new dependency, so swap the declared
        # precedence instead of leaving metadata that contradicts the graph.
        def reposition(step, position):
            return [[key, str(position) if key == "precedence" else value] for key, value in step["parameters"]]
        first_rank = int(dict(first["parameters"])["precedence"])
        second_rank = int(dict(second["parameters"])["precedence"])
        first["parameters"], second["parameters"] = reposition(first, second_rank), reposition(second, first_rank)
        plan = reschedule(plan, [second["id"], first["id"], plan["steps"][2]["id"]])
    elif change == "transformed-view":
        plan["steps"][0]["parameters"] = [[key, "previous_output" if key == "evaluation_view" else value]
                                           for key, value in plan["steps"][0]["parameters"]]
    else:
        target["expectationOverride"] = {"sourcePolicyVersion": "1.0.0", "reason": "Review the full composition.",
            "expectedDecision": "block", "expectedMatches": [{"policyId": "p0", "ruleId": "r-first"}]}
    outcome = await validate(plan, [target], Fault())
    assert not outcome.results[0]["passed"]
    assert outcome.results[0]["actualFailure"] == "provider_failure"
