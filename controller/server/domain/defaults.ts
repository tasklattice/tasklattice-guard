import type { GuardrailDraftConfig } from "./guardrail-plan.js";
import type { PolicyDto } from "../policy-catalog/catalog.js";

export const DEFAULT_GUARDRAIL_ID = "guardrail-default";
export const DEFAULT_GUARDRAIL_NAME = "Default Guardrail";
export const DEFAULT_GUARDRAIL_DESCRIPTION = (
  "Protect unmatched traffic with local input and output checks for credentials, personal data, "
  + "abusive or discriminatory language, physical and self-harm, data exfiltration, prompt injection, "
  + "SQL injection, and malicious code injection. "
  + "No external model is called."
);
export const DEFAULT_DEPLOYMENT_ID = "deployment-default";
export const DEFAULT_DEPLOYMENT_NAME = "Default Deployment";

type DefaultPolicySelection = {
  id: string;
  ruleIds: readonly string[] | null;
  rails: readonly ("input" | "output")[];
};

const DEFAULT_POLICY_SELECTIONS = [
  {
    id: "advanced-au-pii-protection",
    ruleIds: [
      "international-pii-identifiers/us_ssn",
      "international-pii-identifiers/us_ssn_no_dash",
      "contact-information-pii/email",
      "contact-information-pii/us_phone",
    ],
    rails: ["input"],
  },
  { id: "baseline-pii-protection", ruleIds: null, rails: ["input"] },
  {
    id: "pattern-matching",
    ruleIds: [
      "pattern/aws_access_key",
      "pattern/aws_secret_key",
      "pattern/github_token",
      "pattern/slack_token",
      "pattern/generic_api_key",
    ],
    rails: ["input", "output"],
  },
  { id: "filter-denied-insults", ruleIds: null, rails: ["input", "output"] },
  { id: "filter-harm-toxic-abuse", ruleIds: null, rails: ["input", "output"] },
  { id: "filter-harmful-violence", ruleIds: null, rails: ["input", "output"] },
  { id: "filter-harmful-self-harm", ruleIds: null, rails: ["input", "output"] },
  { id: "filter-harmful-child-safety", ruleIds: null, rails: ["input", "output"] },
  { id: "filter-harmful-illegal-weapons", ruleIds: null, rails: ["input", "output"] },
  { id: "filter-bias-gender", ruleIds: null, rails: ["input", "output"] },
  { id: "filter-bias-racial", ruleIds: null, rails: ["input", "output"] },
  { id: "filter-bias-religious", ruleIds: null, rails: ["input", "output"] },
  { id: "filter-bias-sexual-orientation", ruleIds: null, rails: ["input", "output"] },
  { id: "prompt-injection-protection", ruleIds: null, rails: ["input"] },
  { id: "filter-prompt-injection-jailbreak", ruleIds: null, rails: ["input", "output"] },
  { id: "filter-prompt-injection-data-exfiltration", ruleIds: null, rails: ["input", "output"] },
  { id: "filter-prompt-injection-sql", ruleIds: null, rails: ["input", "output"] },
  { id: "filter-prompt-injection-malicious-code", ruleIds: null, rails: ["input", "output"] },
  { id: "filter-prompt-injection-system-prompt", ruleIds: null, rails: ["input", "output"] },
] as const satisfies readonly DefaultPolicySelection[];

/**
 * Build the reserved baseline from the Runner-owned Policy catalog.
 *
 * Every selected Rule is local. Rule-level effects are deliberately preserved:
 * PII and credential-shaped output are redacted while abusive, exfiltration,
 * and injection matches are rejected. The baseline therefore never needs an
 * external model.
 */
export function defaultGuardrailDraft(policies: readonly PolicyDto[]): GuardrailDraftConfig {
  const byId = new Map(policies.map((policy) => [policy.id, policy]));
  const selected = DEFAULT_POLICY_SELECTIONS.map((selection) => {
    const policy = byId.get(selection.id);
    if (!policy) throw new Error(`Default Guardrail Policy ${selection.id} is missing from the Runner catalog.`);
    const selectedRuleIds: readonly string[] | null = selection.ruleIds;
    const selectedRails: readonly ("input" | "output")[] = selection.rails;
    const selectedRules = policy.rules.filter((rule) => (
      rule.rails.some((rail) => selectedRails.includes(rail as "input" | "output"))
      && (selectedRuleIds === null || selectedRuleIds.includes(rule.id))
    ));
    if (!selectedRules.length) throw new Error(`Default Guardrail Policy ${selection.id} has no selected local Rules.`);
    if (selectedRuleIds !== null && selectedRules.length !== selectedRuleIds.length) {
      const found = new Set(selectedRules.map((rule) => rule.id));
      throw new Error(`Default Guardrail Policy ${selection.id} is missing Rules: ${selectedRuleIds.filter((id) => !found.has(id)).join(", ")}.`);
    }
    const enabledRails = selectedRails.filter((rail) => policy.rails.includes(rail));
    if (enabledRails.length !== selectedRails.length) {
      throw new Error(`Default Guardrail Policy ${selection.id} does not support Rails: ${selectedRails.filter((rail) => !policy.rails.includes(rail)).join(", ")}.`);
    }
    return {
      policyId: policy.id,
      policyVersion: policy.version,
      action: null,
      parameterValues: Object.fromEntries(policy.parameters.flatMap((parameter) => (
        parameter.default === null || parameter.default === undefined ? [] : [[parameter.name, parameter.default]]
      ))),
      enabledRuleIds: selectedRules.map((rule) => rule.id),
      ruleActions: {},
      enabledRails,
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
