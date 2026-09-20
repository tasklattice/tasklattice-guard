import { TOPIC_POLICY_ID, TOPIC_POLICY_VERSION, TOPIC_ALLOW_RULE, TOPIC_DENY_RULE, TOPIC_LEGACY_RULE } from "../../shared/topic-policy";
import type { GuardrailPolicyBinding } from "./api";

/** Explicit draft edit only: published bindings and root fields are not rewritten. */
export function upgradeTopicBinding(binding: GuardrailPolicyBinding, allowed: string, denied: string, mode: "strict" | "permissive"): GuardrailPolicyBinding {
  if (binding.policy_id !== TOPIC_POLICY_ID || binding.policy_version !== "1.0.0") return binding;
  const enabled = binding.enabled_rule_ids.includes(TOPIC_LEGACY_RULE);
  const action = binding.rule_actions[TOPIC_LEGACY_RULE] ?? binding.action;
  return { ...binding, policy_version: TOPIC_POLICY_VERSION,
    enabled_rule_ids: enabled ? [...(denied.trim() ? [TOPIC_DENY_RULE] : []), TOPIC_ALLOW_RULE] : [],
    rule_order: [TOPIC_DENY_RULE, TOPIC_ALLOW_RULE],
    rule_actions: action ? { [TOPIC_ALLOW_RULE]: action } : {}, action: null,
    parameter_values: { ...binding.parameter_values, allowed_topics: allowed, denied_topics: denied, topic_mode: mode },
  };
}
