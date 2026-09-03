import type { GuardrailDraftConfig } from "./guardrail-plan.js";
import type { PolicyDto } from "../policy-catalog/catalog.js";
import { defaultTestCaseOverrides } from "./default-expectations.js";

export const DEFAULT_GUARDRAIL_ID = "guardrail-default";
export const DEFAULT_GUARDRAIL_NAME = "Default Guardrail";
export const DEFAULT_GUARDRAIL_DESCRIPTION = (
  "Protect unmatched traffic with complete local Policies for PII, credentials, pattern matching, "
  + "abusive or discriminatory language, harmful content, and prompt injection. "
  + "Policies retain their Rules, scope, and actions; Default supplies explicit local ordering and reviewed composition expectations. No external model is called."
);
export const DEFAULT_DEPLOYMENT_ID = "deployment-default";
export const DEFAULT_DEPLOYMENT_NAME = "Default Deployment";

// Default is a composition of complete, model-free Policies, not a separate
// Rule collection. Policy definitions own their Rules, phases, and actions.
// Baseline PII retains credential rejection and spaced Australian tax IDs;
// Pattern Matching supplies broader PII coverage. Do not also bind Advanced
// PII: it substantially duplicates this pair and adds composition conflicts.
const DEFAULT_POLICY_IDS = [
  "filter-denied-insults",
  "filter-harm-toxic-abuse",
  "filter-harmful-violence",
  "filter-harmful-self-harm",
  "filter-harmful-child-safety",
  "filter-harmful-illegal-weapons",
  "filter-bias-gender",
  "filter-bias-racial",
  "filter-bias-religious",
  "filter-bias-sexual-orientation",
  "prompt-injection-protection",
  "filter-prompt-injection-jailbreak",
  "filter-prompt-injection-data-exfiltration",
  "filter-prompt-injection-sql",
  "filter-prompt-injection-malicious-code",
  "filter-prompt-injection-system-prompt",
  "baseline-pii-protection",
  "pattern-matching",
] as const;

/**
 * Build the reserved baseline from the Runner-owned Policy catalog.
 *
 * The binding snapshot materializes each complete Policy for compilation and
 * observability. All Rules and inherited Test Cases are retained. Ordering and
 * reviewed test expectations belong to Default, never to the source templates.
 */
export function defaultGuardrailDraft(policies: readonly PolicyDto[]): GuardrailDraftConfig {
  const byId = new Map(policies.map((policy) => [policy.id, policy]));
  const selected = DEFAULT_POLICY_IDS.map((policyId) => {
    const policy = byId.get(policyId);
    if (!policy) throw new Error(`Default Guardrail Policy ${policyId} is missing from the Runner catalog.`);
    if (!policy.rules.length) throw new Error(`Default Guardrail Policy ${policyId} has no Rules.`);
    return {
      policyId: policy.id,
      policyVersion: policy.version,
      action: null,
      parameterValues: Object.fromEntries(policy.parameters.flatMap((parameter) => (
        parameter.default === null || parameter.default === undefined ? [] : [[parameter.name, parameter.default]]
      ))),
      enabledRuleIds: policy.rules.map((rule) => rule.id),
      ruleOrder: defaultRuleOrder(policy),
      testCaseOverrides: defaultTestCaseOverrides(policy.id),
      ruleActions: {},
      enabledRails: [...policy.rails],
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

function defaultRuleOrder(policy: PolicyDto): string[] {
  // Authored Default choices, not an engine severity/action sort. Credentials
  // must be inspected before number redaction can break their signature.
  if (policy.id === "baseline-pii-protection") return [
    ...policy.rules.filter((rule) => rule.id.startsWith("credentials-api-keys/")).map((rule) => rule.id),
    "financial-pii/amex", "financial-pii/visa", "financial-pii/mastercard", "financial-pii/discover", "financial-pii/credit_card",
  ];
  if (policy.id === "pattern-matching") return [
    "pattern/aws_access_key", "pattern/aws_secret_key", "pattern/github_token", "pattern/slack_token", "pattern/generic_api_key",
    "pattern/uae_emirates_id", "pattern/ca_on_drivers_licence", "pattern/ca_immigration_doc",
    "pattern/ca_bank_account", "pattern/fr_nir", "pattern/uoft_tcard", "pattern/sg_uen",
    "pattern/ca_ohip", "pattern/ca_sin", "pattern/sg_bank_account",
    "pattern/eu_vat", "pattern/skywards_number", "pattern/nl_bsn_contextual",
    "pattern/passport_singapore", "pattern/passport_china",
    "pattern/visa", "pattern/mastercard", "pattern/amex", "pattern/discover", "pattern/credit_card", "pattern/iban",
    "pattern/sg_phone", "pattern/uae_phone", "pattern/fr_phone", "pattern/br_phone_mobile",
  ];
  return [];
}
