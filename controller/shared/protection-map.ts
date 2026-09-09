/** Business navigation, deliberately independent of NeMo engines and providers. */
import type { GuardrailCategoryId } from "./guardrail-catalog.js";

export const protectionDirectoryIds = [
  "content_safety", "privacy", "business_topics", "content_filters",
  "attacks_and_abuse", "application_injection", "business_rules", "answer_reliability",
] as const;

export type ProtectionDirectoryId = typeof protectionDirectoryIds[number];

const categoryDirectories = {
  content_safety: "content_safety", jailbreak_protection: "attacks_and_abuse", topic_control: "business_topics",
  pii_detection: "privacy", agentic_security: "attacks_and_abuse", tool_calling: "business_rules",
  hallucinations_fact_checking: "answer_reliability", llm_self_check: "answer_reliability", third_party_apis: "business_rules",
} as const satisfies Record<GuardrailCategoryId, ProtectionDirectoryId>;

/** Old published snapshots keep their original classification. An author choice
 * belongs to the new version; it never changes engine, dependencies or Rules. */
export function policyProtectionDirectory(policy: {
  protection_directory?: ProtectionDirectoryId | null | undefined;
  guardrail_category: GuardrailCategoryId;
}): ProtectionDirectoryId {
  return policy.protection_directory ?? categoryDirectories[policy.guardrail_category];
}

export const protectionDirectories = [
  { id: "content_safety", label: "Content safety", description: "Harmful content, harassment, discrimination and abuse." },
  { id: "privacy", label: "Privacy & sensitive information", description: "Personal information, financial identifiers, passwords and credentials." },
  { id: "business_topics", label: "Business topics", description: "Keep conversations within your approved business scope." },
  { id: "content_filters", label: "Words & content filters", description: "Your own words, phrases, brands and content patterns." },
  { id: "attacks_and_abuse", label: "Attacks & abuse", description: "Jailbreaks, prompt manipulation and abusive context padding." },
  { id: "application_injection", label: "Code & application injection", description: "Potentially dangerous code, SQL, templates and rendered content." },
  { id: "business_rules", label: "Business & industry rules", description: "Reviewed business restrictions and industry-specific text controls." },
  { id: "answer_reliability", label: "Answer reliability", description: "Check responses against evidence and explicit business rules." },
] as const satisfies ReadonlyArray<{ id: ProtectionDirectoryId; label: string; description: string }>;

export type PolicyProtection = {
  directory: ProtectionDirectoryId;
  execution: "local" | "model" | "local_then_model" | "custom";
  /** A dependency, not evidence that an assignment is configured or validated. */
  modelCapabilities: string[];
  /** Declared custom-flow requirements; not a proof that all source dependencies are known. */
  evaluationContracts?: string[];
  requiredContext: string[];
  outputStreaming: "not_applicable" | "incremental_check" | "complete_response";
  limitations: string[];
};

export type ProtectionPreset = {
  id: string;
  version: string;
  name: string;
  description: string;
  industry: "general" | "banking" | "securities" | "internet";
  jurisdictions: string[];
  /** Ordered ordinary Policy references, not nested executable Policies. */
  policies: Array<{
    policyId: string;
    policyVersion: string;
    enabledRails: Array<"input" | "output">;
    parameterValues: Record<string, string>;
  }>;
  suggestedTopics: string[];
  optionalPolicyIds: string[];
  limitations: string[];
};
