import type { GuardrailDraftConfig } from "./guardrail-plan.js";
import type { PolicyDto } from "../policy-catalog/catalog.js";

export const DEFAULT_GUARDRAIL_ID = "guardrail-default";
export const DEFAULT_GUARDRAIL_NAME = "Default Guardrail";
export const DEFAULT_GUARDRAIL_DESCRIPTION = (
  "Protect unmatched traffic with local input checks for credentials, personal data, "
  + "prompt injection, SQL injection, and code injection. No external model is called."
);
export const DEFAULT_DEPLOYMENT_ID = "deployment-default";
export const DEFAULT_DEPLOYMENT_NAME = "Default Deployment";

const DEFAULT_POLICY_SELECTIONS = [
  {
    id: "advanced-au-pii-protection",
    ruleIds: [
      "international-pii-identifiers/us_ssn",
      "international-pii-identifiers/us_ssn_no_dash",
      "contact-information-pii/email",
      "contact-information-pii/us_phone",
    ],
  },
  { id: "baseline-pii-protection", ruleIds: null },
  { id: "prompt-injection-protection", ruleIds: null },
] as const;

/**
 * Build the reserved baseline from the Runner-owned Policy catalog.
 *
 * Every selected Rule is input-only and deterministic. Rule-level effects are
 * deliberately preserved: PII is redacted while credential and injection
 * matches are rejected. The baseline therefore never needs an external model.
 */
export function defaultGuardrailDraft(policies: readonly PolicyDto[]): GuardrailDraftConfig {
  const byId = new Map(policies.map((policy) => [policy.id, policy]));
  const selected = DEFAULT_POLICY_SELECTIONS.map((selection) => {
    const policy = byId.get(selection.id);
    if (!policy) throw new Error(`Default Guardrail Policy ${selection.id} is missing from the Runner catalog.`);
    const selectedRuleIds: readonly string[] | null = selection.ruleIds;
    const inputRules = policy.rules.filter((rule) => (
      rule.stages.includes("input") && (selectedRuleIds === null || selectedRuleIds.includes(rule.id))
    ));
    if (!inputRules.length) throw new Error(`Default Guardrail Policy ${selection.id} has no selected input Rules.`);
    if (selectedRuleIds !== null && inputRules.length !== selectedRuleIds.length) {
      const found = new Set(inputRules.map((rule) => rule.id));
      throw new Error(`Default Guardrail Policy ${selection.id} is missing Rules: ${selectedRuleIds.filter((id) => !found.has(id)).join(", ")}.`);
    }
    return {
      policyId: policy.id,
      policyVersion: policy.version,
      action: null,
      parameterValues: Object.fromEntries(policy.parameters.flatMap((parameter) => (
        parameter.default === null || parameter.default === undefined ? [] : [[parameter.name, parameter.default]]
      ))),
      enabledRuleIds: inputRules.map((rule) => rule.id),
      ruleActions: {},
      enabledRails: ["input" as const],
      reasoningPolicy: null,
    };
  });
  return {
    purposeDetails: { audience: "", tasks: "", protect: "", outOfScope: "" },
    allowedTopics: [],
    restrictedTopics: [],
    policyBindings: selected,
    safetyLevel: "balanced",
    outputDelivery: "window_buffered",
  };
}
