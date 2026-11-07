"""Shared authored-order plans for Rank Mode integration tests.

These helpers build the real Controller plan. They do not assert the removed
block-first scheduling optimisations; Rank Mode has one authored order.
"""

from copy import deepcopy
from pathlib import Path
import json
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
      const template = compiler.shipped('content-filters');
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
        blockfirst: plan([policyWith('blockfirst', [rule('r-block', 'block'), rule('r-mask', 'transform', '[MASK]'), rule('r-observe', 'allow')])]),
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


def _binding_plan() -> dict:
    """Build a real Controller plan from one Rule resource bound twice."""
    source = """
      import { DeclarativeCompiler } from '../controller/server/policy-studio/declarative.ts';
      import { buildGuardrailPlan } from '../controller/server/domain/guardrail-plan.ts';
      const compiler = new DeclarativeCompiler('../runner/toolkit/policy_library/assets');
      const template = compiler.shipped('content-filters');
      const definition = structuredClone(template);
      definition.metadata.id = 'binding-slice'; definition.metadata.version = '1.0.0';
      definition.parameters = []; delete definition.testing; definition.tests = [];
      definition.rules = [{
        ...structuredClone(template.rules[0]), id: 'shared/topic-check', name: 'Shared topic check',
        stages: ['input'], detector: { ref: 'text/keyword', version: '1.0.0', parameters: { keywords: [['BASE', 'low']] } },
        on_match: { action: 'block' }, variants: [{ variant_id: 'allow', replacement: '[ALLOW_REDACTED]', description: '' }],
      }];
      definition.bindings = [
        { binding_id: 'denylist', rule_id: 'shared/topic-check', order: 0, action: 'block', parameters: { keywords: [['DENY_TOPIC', 'high']] } },
        { binding_id: 'allowlist', rule_id: 'shared/topic-check', variant_id: 'allow', order: 1, action: 'block', parameters: { keywords: [['ALLOW_TOPIC', 'medium']] } },
      ];
      const policy = compiler.compile(definition);
      const plan = buildGuardrailPlan({
        guardrailId: 'binding-slice', guardrailVersion: '20261023-000000.001Z', policies: [policy],
        draft: { allowedTopics: [], restrictedTopics: [], safetyLevel: 'balanced', outputDelivery: 'full_buffered',
          policyBindings: [{ policyId: policy.id, policyVersion: policy.version, parameterValues: {},
            enabledRuleIds: policy.rules.map(item => item.id), ruleOrder: policy.rules.map(item => item.id),
            ruleActions: {}, enabledRails: ['input'], reasoningPolicy: null }] } });
      console.log(JSON.stringify(plan));
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
              "assertionFailures", "evidenceStatus", "ruleContractSatisfied")
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


