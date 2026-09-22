import type { ProtectionPreset } from "./protection-map.js";

const legacy = (policyId: string, enabledRails: Array<"input" | "output"> = ["input", "output"]) => ({
  policyId, policyVersion: "1.95.0", enabledRails, parameterValues: {},
});
const focused = (policyId: string) => ({ ...legacy(policyId), policyVersion: "2.0.0" });
const china = (policyId: string, enabledRails: Array<"input" | "output"> = ["input", "output"]) => ({
  policyId, policyVersion: "1.0.0", enabledRails, parameterValues: {},
});

// Each industry preset expands to real, pinned Policies. No anonymous Rules or
// runtime inheritance is created. Shared baseline order is authored, not sorted
// by action or severity. Users can review, remove and reorder every binding.
const baseline = [
  focused("local-credentials"),
  legacy("filter-denied-insults"),
  legacy("filter-harmful-self-harm"),
  legacy("filter-harmful-violence"),
  legacy("filter-harmful-child-safety"),
  legacy("filter-harmful-illegal-weapons"),
  legacy("filter-bias-racial"),
  legacy("filter-bias-gender"),
  legacy("filter-bias-religious"),
  legacy("filter-bias-sexual-orientation"),
  legacy("filter-harm-toxic-abuse"),
  focused("local-prompt-manipulation"),
  legacy("filter-prompt-injection-data-exfiltration"),
  focused("local-payment-data"),
  focused("local-passports"),
  focused("local-contact-data"),
];
const limitations = [
  "Local patterns provide basic screening, not complete semantic coverage or guaranteed attack prevention.",
  "Selected output transformations require complete-response buffering, including streaming requests.",
  "Optional model-backed protection is not enabled until explicitly selected, configured and validated.",
];
const financialLimitations = [
  ...limitations,
  "Financial reference controls are text checks, not regulatory compliance, suitability decisions, transaction authorization or certification.",
];
const enhancements = ["builtin-content-safety", "builtin-jailbreak", "builtin-topic-safety", "builtin-contextual-grounding"];
const chinaRuntimeBaseline = [
  focused("local-credentials"),
  focused("local-passports"),
  china("china-personal-identifiers"),
  china("china-prompt-manipulation", ["input"]),
];
const chinaLimitations = [
  "Runtime Enforced: only the selected local identifier, credential and explicit prompt-manipulation patterns run without an external model.",
  "Requires Integration: broader Chinese-language content-risk classification, grounding, generated-content visible and implicit labels, and authenticated transaction context require validated models or application/gateway integration.",
  "Governance Only: filing, security assessment, training-data governance, lawful-basis and consent decisions, cross-border review, retention, human oversight and regulatory reporting are not automated by this Profile.",
  "The jurisdiction label is deployment context, not a legal-scope decision, certification or proof of compliance with mainland-China law or standards.",
  "Redaction can remove identifiers needed by an authorized workflow; use approved structured channels and review field-level handling instead of assuming text redaction is always appropriate.",
];

export const protectionPresets: readonly ProtectionPreset[] = [
  {
    id: "common-baseline", version: "1.0.0", name: "Common baseline", industry: "general", jurisdictions: [],
    description: "Basic local protection for credentials, personal data, harmful phrases and prompt attacks. No external model required.",
    policies: baseline, suggestedTopics: [], optionalPolicyIds: enhancements, limitations,
  },
  {
    id: "banking-assistant", version: "1.0.1", name: "Banking customer service", industry: "banking", jurisdictions: [],
    description: "Common baseline plus identity-check evasion and misleading investment-guarantee patterns. Banking education stays available.",
    policies: [...baseline, focused("banking-customer-protection")],
    suggestedTopics: ["Accounts, cards and payments", "Banking product information", "Customer service and fraud reporting"],
    optionalPolicyIds: [...enhancements, "singapore-customer-identifiers"], limitations: financialLimitations,
  },
  {
    id: "securities-assistant", version: "1.0.1", name: "Securities & brokerage", industry: "securities", jurisdictions: [],
    description: "Common baseline plus insider-trading, market-manipulation and misleading return-guarantee patterns.",
    policies: [...baseline, focused("banking-customer-protection"), focused("securities-market-integrity")],
    suggestedTopics: ["Securities products and risk education", "Brokerage account support", "Public market information"],
    optionalPolicyIds: [...enhancements, "singapore-customer-identifiers"], limitations: financialLimitations,
  },
  {
    id: "internet-customer-support", version: "1.0.0", name: "Internet platform support", industry: "internet", jurisdictions: [],
    description: "Common baseline plus phishing, session theft, SQL/code and rendered-content injection patterns.",
    policies: [...baseline, focused("internet-account-abuse"), focused("local-sql-injection"), focused("local-code-injection"), focused("local-rendered-content-injection")],
    suggestedTopics: ["Product support and troubleshooting", "Account and subscription help", "Trust and safety reporting"],
    optionalPolicyIds: [...enhancements, "keyword-blocking", "competitor-mention-detection"],
    limitations: [...limitations, "Content screening does not replace output encoding, parameterized queries, sandboxing or access control."],
  },
  {
    id: "singapore-financial-assistant", version: "1.0.1", name: "Singapore financial reference", industry: "banking", jurisdictions: ["singapore"],
    description: "Banking baseline plus Singapore customer-identifier and personal-data-use phrase checks. No MAS-specific Policy is included.",
    policies: [...baseline, focused("banking-customer-protection"), focused("singapore-customer-identifiers"), focused("singapore-data-use-boundaries")],
    suggestedTopics: ["Singapore banking customer support", "Financial products and risk education", "Personal-data handling requests"],
    optionalPolicyIds: [...enhancements, "securities-market-integrity"], limitations: [...financialLimitations, "No MAS-specific control is included without a verified, directly relevant MAS source and reviewed Rule-level mapping."],
  },
  {
    id: "china-mainland-runtime", version: "1.0.0", name: "China mainland runtime baseline", industry: "general", jurisdictions: ["cn"],
    description: "Local China-mainland identifier, credential and explicit Chinese prompt-manipulation controls. Broader content governance and generated-content labelling require separate integration.",
    policies: chinaRuntimeBaseline,
    suggestedTopics: [],
    optionalPolicyIds: [...enhancements, "builtin-automated-reasoning", "china-organization-identifiers"],
    limitations: chinaLimitations,
  },
  {
    id: "china-banking-assistant", version: "1.0.0", name: "China mainland banking assistant", industry: "banking", jurisdictions: ["cn"],
    description: "China mainland runtime baseline plus bounded banking-assistant controls for credential theft, identity-check evasion and selected misleading return guarantees.",
    policies: [...chinaRuntimeBaseline, china("china-banking-assistant-boundaries")],
    suggestedTopics: ["账户、银行卡与支付", "银行产品信息与风险教育", "客户服务与反欺诈报告"],
    optionalPolicyIds: [...enhancements, "builtin-automated-reasoning", "china-organization-identifiers", "securities-market-integrity"],
    limitations: [
      ...chinaLimitations,
      "Banking phrase checks do not make credit, suitability, KYC, AML, transaction-authorisation or fraud determinations and do not implement JR/T 0221-2021 evaluation procedures.",
    ],
  },
];
