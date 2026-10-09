import { protectionDirectoryIds, type ProtectionDirectoryId } from "../../shared/protection-map";
import type { GuardrailPolicyBinding, Policy } from "./api-types";
import { boundPolicy } from "./bound-policy";

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

/** A preset only adds missing, pinned Policy bindings. User choices win. */
export function mergePresetBindings(current: GuardrailPolicyBinding[], preset: GuardrailPolicyBinding[]): GuardrailPolicyBinding[] {
  const selected = new Set(current.map((item) => item.policy_id));
  return [...current, ...preset.filter((item) => {
    if (selected.has(item.policy_id)) return false;
    selected.add(item.policy_id);
    return true;
  }).map((item) => structuredClone(item))];
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
