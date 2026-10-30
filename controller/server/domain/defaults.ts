import type { GuardrailDraftConfig } from "./guardrail-plan.js";
import type { PolicyDto } from "../policy-catalog/catalog.js";
import { defaultPolicySelection } from "../../shared/default-policy-selection.js";
import { defaultTestCaseOverrides } from "./default-expectations.js";

export const DEFAULT_GUARDRAIL_ID = "guardrail-default";
export const DEFAULT_GUARDRAIL_NAME = "Default Guardrail";

// Capability additions remain opt-in. Preserve the reviewed Rule order and handling.
/**
 * Build the reserved baseline from the Runner-owned Policy catalog.
 *
 * The binding snapshot materializes the reviewed Rules for compilation and
 * observability. New catalog Rules are opt-in. Ordering and
 * reviewed test expectations belong to Default, never to the source templates.
 */
export function defaultGuardrailDraft(policies: readonly PolicyDto[]): GuardrailDraftConfig {
  const byId = new Map(policies.map((policy) => [policy.id, policy]));
  const selected = defaultPolicySelection.map(({ policyId, ruleIds }) => {
    const policy = byId.get(policyId);
    if (!policy) throw new Error(`Default Guardrail Policy ${policyId} is missing from the Runner catalog.`);
    if (!policy.rules.length) throw new Error(`Default Guardrail Policy ${policyId} has no Rules.`);
    if (policy.protection.execution !== "local"
      || policy.rules.some((rule) => !["local", "platform"].includes(rule.implementation.execution))) {
      throw new Error(`Default Guardrail Policy ${policyId} must use verified local implementations.`);
    }
    const knownRules = new Set(policy.rules.map(rule => rule.id));
    if (ruleIds.some(id => !knownRules.has(id))) throw new Error(`Default Guardrail Policy ${policyId} is missing a reviewed Rule.`);
    return {
      policyId: policy.id,
      policyVersion: policy.version,
      action: null,
      parameterValues: Object.fromEntries(policy.parameters.flatMap((parameter) => (
        parameter.default === null || parameter.default === undefined ? [] : [[parameter.name, parameter.default]]
      ))),
      enabledRuleIds: [...ruleIds],
      ruleOrder: [...ruleIds],
      testCaseOverrides: defaultTestCaseOverrides(policy.id),
      ruleActions: policy.id === "local-content-safety"
        ? { "category/denied_insults": "allow" as const }
        : {},
      enabledRails: [...policy.rails],
      reasoningPolicy: null,
    };
  });
  return {
    allowedTopics: [],
    restrictedTopics: [],
    policyBindings: selected,
    safetyLevel: "balanced",
    // The local PII transformations need the complete response. Make the
    // configured behavior agree with the runtime contract instead of asking
    // for incremental delivery that can only fall back to full buffering.
    outputDelivery: "full_buffered",
  };
}
