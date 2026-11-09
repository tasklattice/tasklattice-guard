import { parsePhraseEntries } from "../../shared/phrase-policy.js";
import type { PolicyDto } from "../policy-catalog/catalog.js";
import type { GuardrailPolicyBindingConfig } from "./guardrail-plan.js";

/** Expand authoring entries into ordinary Rules before compiling the execution plan. */
export function materializePolicyRules(policy: PolicyDto, binding: GuardrailPolicyBindingConfig): PolicyDto {
  const expansions = new Map<string, PolicyDto["rules"]>();
  const rules = policy.rules.flatMap(rule => {
    if (!rule.rule_expansion) return [rule];
    const spec = rule.rule_expansion;
    const entries = parsePhraseEntries(binding.parameterValues[spec.parameter] ?? "");
    const concrete = entries.map(entry => ({
      ...rule, id: `${rule.id}/${entry.id}`, name: entry.phrase,
      rule_expansion: null, keywords: [],
      detector_options: { terms: [entry.phrase], literal: true },
      effect: binding.ruleActions[rule.id] ?? binding.action ?? entry.action,
      redaction: entry.replacement,
      risk_severity: rule.risk_severity,
      implementation: { ...rule.implementation, implementation_rule_id: `${rule.id}/${entry.id}` },
    }));
    expansions.set(rule.id, concrete);
    return concrete;
  });
  if (!expansions.size) return policy;
  const expandIds = (ids: string[]) => ids.flatMap(id => expansions.get(id)?.map(rule => rule.id) ?? [id]);
  binding.enabledRuleIds = expandIds(binding.enabledRuleIds);
  binding.ruleOrder = expandIds(binding.ruleOrder ?? []);
  binding.ruleActions = Object.fromEntries(Object.entries(binding.ruleActions).flatMap(([id, action]) => expandIds([id]).map(id => [id, action])));
  return { ...policy, rules, test_cases: policy.test_cases.map(test => ({ ...test, covered_rule_ids: expandIds(test.covered_rule_ids) })) };
}
