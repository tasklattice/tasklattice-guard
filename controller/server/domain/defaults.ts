import type { GuardrailDraftConfig } from "./guardrail-plan.js";
import type { PolicyDto } from "../policy-catalog/catalog.js";
import { defaultTestCaseOverrides } from "./default-expectations.js";

export const DEFAULT_GUARDRAIL_ID = "guardrail-default";
export const DEFAULT_GUARDRAIL_NAME = "Default Guardrail";
export const DEFAULT_ROUTER_ID = "router-default";
export const DEFAULT_ROUTER_NAME = "Default Router";

// Default is a composition of complete, model-free Policies, not a separate
// Rule collection. Policy definitions own their Rules, phases, and actions.
// Focused bindings replace the three mixed legacy collections. Credentials
// precede numeric redaction; complete payment values precede broad tax formats;
// contextual bank/travel/government identifiers precede broad contact formats.
// This is an authored Policy order, never an action/severity ranking.
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
  "local-prompt-manipulation",
  "local-sql-injection",
  "local-code-injection",
  "local-rendered-content-injection",
  "filter-prompt-injection-jailbreak",
  "filter-prompt-injection-data-exfiltration",
  "filter-prompt-injection-sql",
  "filter-prompt-injection-malicious-code",
  "filter-prompt-injection-system-prompt",
  "local-credentials",
  "local-payment-data",
  "local-australian-tax-health-identifiers",
  "local-bank-account-formats",
  "local-travel-identifiers",
  "local-government-identifiers",
  "local-passport-formats",
  "local-regional-contact-formats",
  "local-contact-data",
  "local-passports",
  "local-network-addresses",
  "local-sensitive-attribute-terms",
  "local-risk-content-terms",
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
    if (policy.protection.execution !== "local" || policy.protection.modelCapabilities.length
      || policy.rules.some((rule) => rule.form === "colang_flow")) {
      throw new Error(`Default Guardrail Policy ${policyId} must execute locally without a Model or an unverified custom flow.`);
    }
    return {
      policyId: policy.id,
      policyVersion: policy.version,
      action: null,
      parameterValues: Object.fromEntries(policy.parameters.flatMap((parameter) => (
        parameter.default === null || parameter.default === undefined ? [] : [[parameter.name, parameter.default]]
      ))),
      enabledRuleIds: policy.rules.map((rule) => rule.id),
      ruleOrder: [],
      testCaseOverrides: defaultTestCaseOverrides(policy.id),
      ruleActions: {},
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
