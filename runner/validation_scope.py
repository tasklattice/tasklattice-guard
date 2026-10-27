"""A test-only projection. The signed publication Artifact is never changed."""
from __future__ import annotations

from copy import deepcopy
from typing import Any

LOCAL_CONTRACTS = frozenset({
    "tali.guard.secrets.exact.v1", "tali.guard.pii.exact.v1",
    "tali.guard.content-filter.rules.v1", "tali.guard.prompt-injection.v1",
    "tali.guard.indirect-prompt-injection.v1", "tali.guard.memory-poisoning.v1",
    "tali.guard.system-prompt-leakage.v1", "tali.guard.topic-control.rules.v1",
})


def local_test_plan(plan: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """Keep registered local evaluators, including local Rules in mixed Policies.

    Arbitrary Colang cannot be proven local from declarations alone. Its Rules,
    and local steps conditional on excluded steps, are explicitly skipped.
    """
    scoped = deepcopy(plan)
    bindings = {b["policy_id"]: b for b in plan.get("policy_bindings", [])}
    steps = plan.get("steps", [])
    removed = {s["id"] for s in steps if s["contract_ref"] not in LOCAL_CONTRACTS}
    def rule_refs(step):
        params = dict(step.get("parameters", []))
        policies = [params["policy_id"]] if params.get("policy_id") else params.get("policy_ids", "").splitlines()
        return {(p, r) for p in policies for r in (
            [params["rule_id"]] if params.get("rule_id") else bindings.get(p, {}).get("enabled_rule_ids", []))}

    while True:
        excluded_rules = set().union(*(rule_refs(s) for s in steps if s["id"] in removed))
        dependent = {s["id"] for s in steps if s.get("trigger", {}).get("step_ref") in removed}
        # A per-Rule local step must not run a partial model-dependent Rule.
        dependent |= {s["id"] for s in steps
                      if dict(s.get("parameters", [])).get("rule_id") and rule_refs(s) & excluded_rules}
        if dependent <= removed:
            break
        removed |= dependent
    skipped: dict[tuple[str, str], str] = {}
    kept: dict[str, set[str]] = {}
    for step in steps:
        for policy, rule in rule_refs(step):
            if step["id"] in removed:
                skipped[policy, rule] = "Model-dependent Rule or dependency is outside this test scope."
            else:
                kept.setdefault(policy, set()).add(rule)
    for binding in bindings.values():
        for rule in binding.get("enabled_rule_ids", []):
            key = binding["policy_id"], rule
            if rule not in kept.get(key[0], set()) and key not in skipped:
                skipped[key] = "Custom or unclassified Rule cannot be verified as model-independent."
    # A Rule requiring both local and model steps is excluded as a whole.
    scoped["steps"] = [s for s in scoped.get("steps", []) if s["id"] not in removed]
    ids = {s["id"] for s in scoped["steps"]}
    scoped["modules"] = [m for m in scoped.get("modules", []) if any(s in ids for s in m["step_ids"])]
    modules = {m["id"] for m in scoped["modules"]}
    for module in scoped["modules"]:
        module["step_ids"] = [s for s in module["step_ids"] if s in ids]
        module["depends_on"] = [s for s in module.get("depends_on", []) if s in modules]
    scoped["policy_versions"] = []  # Arbitrary native flows are not executed.
    scoped["policy_bindings"] = []
    for binding in bindings.values():
        rules = [r for r in binding.get("enabled_rule_ids", []) if r in kept.get(binding["policy_id"], set())
                 and (binding["policy_id"], r) not in skipped]
        if not rules:
            continue
        item = deepcopy(binding)
        item["enabled_rule_ids"] = rules
        item["rule_order"] = [r for r in item.get("rule_order", []) if r in rules]
        for key in ("rule_actions", "rule_severities"):
            item[key] = [pair for pair in item.get(key, []) if pair[0] in rules]
        scoped["policy_bindings"].append(item)
    return scoped, [{"policyId": p, "ruleId": r, "reason": reason} for (p, r), reason in sorted(skipped.items())]


def skipped_case(case: dict[str, Any], skipped_rules: list[dict[str, str]]) -> dict[str, Any] | None:
    policy = case.get("sourcePolicyId") or case.get("policyId")
    covered = set(case.get("coveredRuleIds", []))
    refs = {(r["policyId"], r["ruleId"]) for r in skipped_rules}
    affected = any(p == policy and (not covered or r in covered) for p, r in refs)
    override = case.get("expectationOverride") or {}
    affected |= any((m["policyId"], m["ruleId"]) in refs for m in override.get("expectedMatches", []))
    if not affected:
        return None
    return {
        **case, "caseId": case["id"], "inputContent": case.get("content", ""),
        "expectedDecision": override.get("expectedDecision", case.get("expectedDecision")),
        "passed": False, "skipped": True,
        "evidenceStatus": "not_reached", "evidenceDetail": "The target Rule is outside this test scope.",
        "verifiedRuleIds": [], "supersededBy": [], "ruleContractSatisfied": False,
        "skipReason": "Model-dependent tests skipped: this case requires an excluded Rule.",
        "reason": "Model-dependent tests skipped: this case requires an excluded Rule.",
        "actualDecision": "", "action": "", "outputContent": "",
        "findings": [], "trace": [], "evaluatorIds": [], "latencyMs": 0,
        "matchedRuleIds": [], "evaluationContracts": [], "escalated": False, "modelInvocations": 0,
    }
