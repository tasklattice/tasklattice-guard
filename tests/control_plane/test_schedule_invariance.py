"""A compiled schedule is an optimisation: it must not change Test verdicts.

The Controller schedules read-only Block checks first, then serial Transform
steps, then Allow observations. This suite executes the *same* Guardrail under
three legal schedules of the same plan and requires the observable decision,
output, Rule evidence and per-case verdict to be identical. A future scheduling
optimisation therefore cannot silently rewrite what testing means.

Nothing here is generated from runtime results: the expected decisions come from
the action contract (Block wins, Transform composes, Allow observes).
"""
from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
import subprocess
import random
from itertools import permutations

import pytest

from runner import generated as protocol
from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.protocol_codec import plan_to_proto, validation_test_to_proto
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions.content_filter import ContentFilterActionProvider
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from runner.validator import DefaultRunnerValidator

ROOT = Path(__file__).resolve().parents[2]


def _controller_plans() -> dict[str, dict]:
    """Build real Controller plans for Policies with mixed Rule actions."""
    source = """
      import { DeclarativeCompiler } from '../controller/server/policy-studio/declarative.ts';
      import { buildGuardrailPlan } from '../controller/server/domain/guardrail-plan.ts';
      const compiler = new DeclarativeCompiler('../runner/toolkit/policy_library/assets');
      const template = compiler.shipped('keyword-blocking');
      const rule = (id, action, replacement) => ({
        ...structuredClone(template.rules[0]), id, name: id, stages: ['input', 'output'],
        detector: { ref: 'text/keyword', version: '1.0.0', parameters: { keywords: [['alpha', 'low']] } },
        on_match: { action, ...(replacement ? { replacement } : {}) }, runtime_adapter: undefined,
      });
      const policyWith = (id, rules) => {
        const definition = structuredClone(template);
        definition.metadata.id = id; definition.metadata.version = '1.0.0';
        definition.parameters = []; delete definition.testing; definition.tests = [];
        definition.rules = rules;
        return compiler.compile(definition);
      };
      const plan = (policies) => buildGuardrailPlan({
        guardrailId: 'invariance', guardrailVersion: '20261023-000000.001Z', policies,
        draft: { allowedTopics: [], restrictedTopics: [], safetyLevel: 'balanced', outputDelivery: 'full_buffered',
          policyBindings: policies.map(p => ({ policyId: p.id, policyVersion: p.version, parameterValues: {},
            enabledRuleIds: p.rules.map(item => item.id), ruleOrder: p.rules.map(item => item.id),
            ruleActions: {}, enabledRails: ['input', 'output'], reasoningPolicy: null })) } });
      const grouped = policyWith('grouped', [rule('r-first', 'block'), rule('r-second', 'block'), rule('r-observe', 'allow')]);
      delete grouped.definition;
      console.log(JSON.stringify({
        grouped: plan([grouped]),
        mix: plan([policyWith('mix', [rule('r-mask', 'transform', '[MASK]'), rule('r-block', 'block'), rule('r-observe', 'allow')])]),
        views: plan([policyWith('views', [rule('r-observe', 'allow'), rule('r-mask', 'transform', '[MASK]')])]),
        shadowed: plan([policyWith('shadowed', [rule('r-first', 'transform', '[FIRST]'), rule('r-second', 'transform', '[SECOND]'), rule('r-observe', 'allow')])]),
        ...Object.fromEntries(['allow', 'block', 'transform'].flatMap(a =>
          ['allow', 'block', 'transform'].flatMap(b => [false, true].map(cross => {
            const rules = [rule('r-first', a, '[FIRST]'), rule('r-second', b, '[SECOND]'), rule('r-observe', 'allow')];
            return [`${a}-${b}-${cross}`, plan(cross ? rules.map((r, i) => policyWith(`p${i}`, [r])) : [policyWith('mix', rules)])];
          })))),
      }));
    """
    result = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", source],
        cwd=ROOT / "controller", capture_output=True, text=True, check=True, timeout=60,
    )
    return json.loads(result.stdout)


@pytest.fixture(scope="module")
def plans() -> dict[str, dict]:
    return _controller_plans()


def precedence(plan: dict) -> list[str]:
    """The authored arbitration order the plan declares for itself."""
    return [
        step["id"]
        for step in sorted(plan["steps"], key=lambda item: int(dict(item["parameters"])["precedence"]))
    ]


def rule_order(plan: dict) -> list[str]:
    return [step["id"].split(":")[2] for step in sorted(
        plan["steps"], key=lambda item: int(dict(item["parameters"])["precedence"]))]


def reschedule(plan: dict, order: list[str]) -> dict:
    """Serialise a legal order, retaining views, triggers and Transform order."""
    reordered = deepcopy(plan)
    reordered["steps"].sort(key=lambda step: order.index(step["id"]))
    for step in reordered["steps"]:
        step["parameters"] = [[key, value] for key, value in step["parameters"]
                              if not key.startswith(("parallel_group_", "parallel_leader_"))]
    by_phase: dict[str, list[dict]] = {}
    for module in reordered["modules"]:
        by_phase.setdefault(module["phase"], []).append(module)
    for modules in by_phase.values():
        modules.sort(key=lambda module: min(order.index(step_id) for step_id in module["step_ids"]))
        previous = None
        for module in modules:
            module["depends_on"] = [previous] if previous else []
            previous = module["id"]
    reordered["modules"] = [module for modules in by_phase.values() for module in modules]
    return reordered


def authored_schedule(plan: dict) -> dict:
    return reschedule(plan, precedence(plan))


def schedules(plan: dict) -> list[dict]:
    """Block-first, authored and seeded legal topological permutations.

    Only original-view independent checks commute; the Transform chain and
    on_result edges stay ordered. Three distinct orders are required here.
    """
    authored = precedence(plan)
    transforms = [step["id"] for step in sorted(plan["steps"], key=lambda s: authored.index(s["id"]))
                  if dict(step["parameters"])["evaluation_view"] == "previous_output"]
    edges = list(zip(transforms, transforms[1:])) + [
        (step["trigger"]["step_ref"], step["id"]) for step in plan["steps"]
        if step["trigger"]["type"] == "on_result"]
    legal = [list(order) for order in permutations(authored)
             if all(order.index(a) < order.index(b) for a, b in edges)]
    random.Random(73).shuffle(legal)
    orders = []
    for order in [[s["id"] for s in plan["steps"]], authored, *legal]:
        if order not in orders:
            orders.append(order)
        if len(orders) == 3:
            break
    assert len(orders) == 3
    return [reschedule(plan, order) for order in orders]


def requests(plan: dict, cases: list[dict]) -> list[dict]:
    bindings = {b["policy_id"]: b for b in plan["policy_bindings"]}
    result = []
    for case in cases:
        policy_id = case.get("sourcePolicyId", plan["policy_bindings"][0]["policy_id"])
        result.append({**case, "policyId": policy_id, "sourcePolicyId": policy_id,
                       "sourcePolicyVersion": bindings[policy_id]["policy_version"],
                       "sourceCaseId": case["id"], "caseType": "rule_acceptance", "required": True})
    return result


def semantic_result(result):
    # Timing, execution ordering and first-veto prose are intentionally excluded.
    fields = ("expectedDecision", "actualDecision", "outputContent", "passed",
              "assertionFailures", "evidenceStatus", "ruleContractSatisfied", "evidenceContract")
    return {**{key: result[key] for key in fields},
            "matched": sorted(result["matchedRuleIds"]),
            "verified": sorted(result["verifiedRuleIds"]),
            "findings": sorted((f["policy_id"], f["rule_id"], f["verdict"], f["recommended_action"], f["taxonomy_id"])
                               for f in result["findings"]),
            "superseded": sorted((m["policyId"], m["ruleId"]) for m in result["supersededBy"])}


async def validate(plan: dict, cases: list[dict], run_id: str) -> dict[str, dict]:
    request = protocol.ValidationRequest(
        run_id=run_id, guardrail_id="invariance", candidate_version="20261023-000000.001Z",
        plan=plan_to_proto(plan),
        test_cases=[validation_test_to_proto(case) for case in requests(plan, cases)],
    )
    outcome = await DefaultRunnerValidator(DefaultRunnerCompiler()).run(request)
    assert outcome.test_scope is None or outcome.test_scope["modelInvocations"] == 0
    return {item["caseId"]: item for item in outcome.results}


@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("cross", [False, True])
@pytest.mark.parametrize("actions", [(a, b) for a in ("allow", "block", "transform")
                                    for b in ("allow", "block", "transform")])
async def test_action_matrix_has_identical_evidence_under_three_legal_schedules(plans, phase, cross, actions):
    first, second = actions
    plan = plans[f"{first}-{second}-{str(cross).lower()}"]
    cases = [{"id": "first", "content": "alpha beta", "phase": phase,
              "expectedDecision": first, "coveredRuleIds": ["r-first"], "sourcePolicyId": "p0" if cross else "mix"},
             {"id": "second", "content": "alpha beta", "phase": phase,
              "expectedDecision": second, "coveredRuleIds": ["r-second"], "sourcePolicyId": "p1" if cross else "mix"},
             {"id": "safe", "content": "ordinary request", "phase": phase,
              "expectedDecision": "allow", "coveredRuleIds": ["r-second"], "sourcePolicyId": "p1" if cross else "mix"}]
    runs = [await validate(alternative, cases, f"schedule-{i}") for i, alternative in enumerate(schedules(plan))]
    for case in cases:
        assert semantic_result(runs[0][case["id"]]) == semantic_result(runs[1][case["id"]]) == semantic_result(runs[2][case["id"]])
    expected = "block" if "block" in actions else "transform" if "transform" in actions else "allow"
    assert runs[0]["first"]["actualDecision"] == expected
    assert runs[0]["first"]["outputContent"] == ("" if expected == "block" else "[FIRST] beta" if first == "transform" else "[SECOND] beta" if second == "transform" else "alpha beta")
    assert runs[0]["safe"]["passed"]
    assert runs[0]["safe"]["evidenceStatus"] == "absent"
    if first == second == "transform":
        assert not runs[0]["second"]["passed"]
        assert runs[0]["second"]["evidenceStatus"] == "shadowed_by"
        assert runs[0]["second"]["verifiedRuleIds"] == []


@pytest.mark.parametrize("phase", ["input", "output"])
async def test_reviewed_override_collects_mask_and_block_evidence_in_every_schedule(plans, phase):
    plan = plans["mix"]
    case = {"id": "reviewed", "phase": phase, "content": "alpha beta", "expectedDecision": "transform",
            "coveredRuleIds": ["r-mask"], "expectationOverride": {
                "sourcePolicyVersion": plan["policy_bindings"][0]["policy_version"],
                "reason": "Reviewed composition: retain masking evidence and veto delivery.",
                "expectedDecision": "block", "expectedOutputContent": "",
                "expectedMatches": [{"policyId": "mix", "ruleId": rule} for rule in ("r-mask", "r-block")]}}
    results = [(await validate(order, [case], f"override-{i}"))["reviewed"] for i, order in enumerate(schedules(plan))]
    assert all(result["passed"] for result in results)
    assert all(result["matchedRuleIds"] == ["r-block", "r-mask", "r-observe"] for result in results)
    assert semantic_result(results[0]) == semantic_result(results[1]) == semantic_result(results[2])


@pytest.mark.asyncio
async def test_read_only_checks_inspect_the_phase_input_on_every_schedule(plans) -> None:
    """The mechanism behind the invariant: a view is declared, not inherited."""

    class Recorder(ContentFilterActionProvider):
        def __init__(self) -> None:
            super().__init__()
            self.calls: list[tuple[str, str]] = []

        async def execute(self, request):
            for rules in json.loads(dict(request.parameters)["enabled_rules_json"]).values():
                for rule_id in rules:
                    self.calls.append((rule_id, request.content))
            return await super().execute(request)

    async def observe(plan: dict, name: str) -> tuple[list[tuple[str, str]], str, tuple[str, ...]]:
        recorder = Recorder()
        previews = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(recorder))
        try:
            decision = await previews.evaluate(
                ProtectionRequest(phase="input", texts=("alpha beta",), context=RequestContext(protocol="playground")),
                preview_id=name, guardrail_id="invariance", draft_revision=1,
                candidate_version="20261023-000000.001Z", plan=plan, runtime_profile="auto",
            )
        finally:
            await previews.shutdown()
        return recorder.calls, decision.decision, decision.texts

    scheduled = plans["views"]
    alternative = authored_schedule(scheduled)
    # Authored order observes before masking; the optimisation masks first.
    assert [step["id"].split(":")[2] for step in scheduled["steps"]] == ["r-mask", "r-observe"]
    assert rule_order(alternative) == ["r-observe", "r-mask"]

    optimised = await observe(scheduled, "views-optimised")
    authored = await observe(alternative, "views-authored")
    # Order may differ between schedules; the text each Rule inspects may not.
    assert sorted(optimised[0]) == sorted(authored[0])
    calls, decision, texts = optimised
    # The Allow observer is read-only: it always inspects the phase input, so a
    # preceding Transform cannot erase its evidence.
    assert calls == [("r-mask", "alpha beta"), ("r-observe", "alpha beta")]
    assert dict(authored[0]) == dict(calls)
    assert decision == "transform"
    assert texts == ("[MASK] beta",)


@pytest.mark.parametrize("change,status", [("shadowed", "shadowed_by"), ("omitted", "missing"), ("nonmatching", "not_matched")])
async def test_another_transform_cannot_satisfy_a_missing_or_nonmatching_rule(plans, change, status):
    plan = deepcopy(plans["shadowed"])
    if change == "omitted":
        removed = {step["id"] for step in plan["steps"] if step["id"].split(":")[2] == "r-second"}
        plan["steps"] = [step for step in plan["steps"] if step["id"] not in removed]
        plan["modules"] = [module for module in plan["modules"] if not set(module["step_ids"]) & removed]
        for module in plan["modules"]:
            module["depends_on"] = []
    if change == "nonmatching":
        for step in plan["steps"]:
            if step["id"].split(":")[2] == "r-second":
                step["parameters"] = [[key, value.replace("alpha", "omega")] for key, value in step["parameters"]]
    case = {"id": "second", "phase": "input", "content": "alpha beta", "expectedDecision": "transform", "coveredRuleIds": ["r-second"]}
    result = (await validate(plan, [case], change))["second"]
    assert result["actualDecision"] == "transform"
    assert result["outputContent"] == "[FIRST] beta"
    assert not result["passed"]
    assert result["evidenceStatus"] == status
    assert result["verifiedRuleIds"] == []
    if change == "shadowed":
        case["expectationOverride"] = {
            "sourcePolicyVersion": plan["policy_bindings"][0]["policy_version"],
            "reason": "Reviewed complete replacement by the first Transform.",
            "expectedDecision": "transform", "expectedOutputContent": "[FIRST] beta",
            "expectedMatches": [{"policyId": "shadowed", "ruleId": "r-first"}]}
        reviewed = (await validate(plan, [case], "reviewed-shadowing"))["second"]
        assert reviewed["passed"]
        assert reviewed["evidenceStatus"] == "shadowed_by"
        assert reviewed["verifiedRuleIds"] == []


@pytest.mark.parametrize("phase", ["input", "output"])
async def test_full_evidence_reaches_every_rule_inside_a_grouped_action(plans, phase):
    plan = plans["grouped"]
    assert len(plan["steps"]) == 2  # Two Block Rules share an Action; Allow is separate.
    case = {"id": "both", "phase": phase, "content": "alpha beta", "expectedDecision": "block",
            "coveredRuleIds": ["r-first", "r-second"]}
    result = (await validate(plan, [case], "grouped-full"))["both"]
    assert result["passed"]
    assert result["evidenceStatus"] == "observed"
    assert result["verifiedRuleIds"] == ["r-first", "r-second"]
    runtime = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(ContentFilterActionProvider()))
    try:
        fast = await runtime.evaluate(ProtectionRequest(phase=phase, texts=("alpha beta",), context=RequestContext(protocol="playground")),
            preview_id="grouped-fast", guardrail_id="invariance", draft_revision=1,
            candidate_version=plan["guardrail_version"], plan=plan, runtime_profile="auto")
        assert fast.decision == "block"
        assert {finding.rule_id for finding in fast.findings} == {"r-first"}
    finally:
        await runtime.shutdown()
