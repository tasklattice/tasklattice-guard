import { protectionDirectoryIds, type ProtectionDirectoryId } from "../../shared/protection-map";
import type { GuardrailPolicyBinding, Policy } from "./api-types";
import { boundPolicy } from "./bound-policy";
import { appendProfileRules } from "../../shared/profile-rule-selection";

/** Metadata owns classification; custom/older Policies stay discoverable. */
export function policyDirectory(policy: Policy): ProtectionDirectoryId {
  return declaredPolicyDirectory(policy) ?? "business_rules";
}

/**
 * The directory a Policy declares. A released definition carries its
 * protection tag but no derived protection profile, so read the tag too.
 */
export function declaredPolicyDirectory(policy: Policy): ProtectionDirectoryId | null {
  if (policy.protection) return policy.protection.directory;
  const tag = policy.tags?.find((item) => item.namespace === "protection")?.value;
  return protectionDirectoryIds.find((id) => id === tag) ?? null;
}

/** Editing one directory must not regroup the globally ordered pipeline. */
export function mergeDirectoryBindings(
  current: GuardrailPolicyBinding[],
  visibleIds: ReadonlySet<string>,
  next: GuardrailPolicyBinding[],
): GuardrailPolicyBinding[] {
  const updates = new Map(next.filter((item) => visibleIds.has(item.policy_id)).map((item) => [item.policy_id, item]));
  const merged = current.flatMap((item) => {
    if (!visibleIds.has(item.policy_id)) return [item];
    const updated = updates.get(item.policy_id);
    updates.delete(item.policy_id);
    return updated ? [updated] : [];
  });
  return [...merged, ...updates.values()];
}

/** Add missing bindings and same-version Rules. Existing settings and order win. */
export function mergePresetBindings(current: GuardrailPolicyBinding[], preset: GuardrailPolicyBinding[]): GuardrailPolicyBinding[] {
  const result = structuredClone(current);
  for (const incoming of preset) {
    const existing = result.find(item => item.policy_id === incoming.policy_id);
    if (!existing) result.push(structuredClone(incoming));
    else if (existing.policy_version === incoming.policy_version) {
      const selection = appendProfileRules(
        { enabledRuleIds: existing.enabled_rule_ids, ruleOrder: existing.rule_order },
        { enabledRuleIds: incoming.enabled_rule_ids, ruleOrder: incoming.rule_order });
      if (selection) {
        existing.enabled_rule_ids = selection.enabledRuleIds;
        existing.rule_order = selection.ruleOrder;
      }
    }
  }
  return result;
}

export function completeResponsePolicies(bindings: GuardrailPolicyBinding[], policies: Policy[]): string[] {
  return bindings.filter((binding) => {
    if (!binding.enabled_rails.includes("output")) return false;
    const policy = boundPolicy(policies, binding);
    // Only native content-safety reject/pass/report has a bounded streaming
    // contract today. Unknown/custom checks remain conservatively buffered.
    if (policy?.protection?.outputStreaming !== "incremental_check") return true;
    const actions = [binding.action, ...Object.values(binding.rule_actions)].filter(Boolean);
    return actions.some((action) => !["block", "allow", "report"].includes(action!));
  }).map((binding) => boundPolicy(policies, binding)?.name ?? binding.policy_id);
}
