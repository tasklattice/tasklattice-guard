export const guardrailRailTypes = ["input", "output", "retrieval", "dialog", "execution"] as const;
export type GuardrailRailType = (typeof guardrailRailTypes)[number];

export const implementedGuardrailRailTypes = ["input", "output"] as const satisfies readonly GuardrailRailType[];
export type ImplementedGuardrailRailType = (typeof implementedGuardrailRailTypes)[number];

// DeepSeek is reserved for control-plane authoring and intent understanding.
// Runtime Rails must use bounded, purpose-built or low-parameter providers.
export const controlPlaneOnlyProviderKinds = ["deepseek"] as const;

export function isDataPlaneProviderKindAllowed(kind: string): boolean {
  return !(controlPlaneOnlyProviderKinds as readonly string[]).includes(kind);
}

export const guardrailCategoryIds = [
  "content_safety",
  "jailbreak_protection",
  "topic_control",
  "pii_detection",
  "agentic_security",
  "tool_calling",
  "hallucinations_fact_checking",
  "llm_self_check",
  "third_party_apis",
] as const;

export type GuardrailCategoryId = (typeof guardrailCategoryIds)[number];

export const guardrailCategoryLabels: Record<GuardrailCategoryId, string> = {
  content_safety: "Content Safety",
  jailbreak_protection: "Jailbreak Protection",
  topic_control: "Topic Control",
  pii_detection: "PII Detection",
  agentic_security: "Agentic Security",
  tool_calling: "Tool Calling",
  hallucinations_fact_checking: "Hallucinations & Fact-Checking",
  llm_self_check: "LLM Self-Check",
  third_party_apis: "Third-Party APIs",
};

export const modelCapabilityIds = [
  "classifier_review",
  "content_safety",
  "jailbreak",
  "topic_control",
  "pii_semantic",
  "contextual_grounding",
  "automated_reasoning",
] as const;

export type ModelCapabilityId = (typeof modelCapabilityIds)[number];

export const controlPlaneProfileRefs = ["generic-chat"] as const;
export const typeSafeProfileRefs = ["tali.typesafe-jev.v1", "tali.typesafe-jev-topic.v1"] as const;
export const isTypeSafeProfile = (profile: string): profile is typeof typeSafeProfileRefs[number] => (typeSafeProfileRefs as readonly string[]).includes(profile);
export const layaProfileRefs = ["tali.laya.v1", "tali.laya-topic.v1"] as const;
export const isLayaProfile = (profile: string): profile is typeof layaProfileRefs[number] => (layaProfileRefs as readonly string[]).includes(profile);

export const capabilityProfileRefs = {
  classifier_review: ["tali.classifier-review.v1"],
  content_safety: [
    "tali.typesafe-jev.v1",
    "tali.laya.v1",
    "tali.qwen3guard.v1",
    "tali.llama-guard-3.v1",
    "tali.nemotron-content-safety.v1",
    "tali.nemotron-safety-guard-v3.v1",
  ],
  jailbreak: [
    "tali.typesafe-jev.v1",
    "tali.laya.v1",
    "tali.qwen3guard.v1",
    "tali.openai-compatible-jailbreak.v1",
    "tali.nemoguard-jailbreak-detect.v1",
  ],
  topic_control: ["tali.taxonomy-judge.v1", "tali.nemoguard-topic-control.v1", ...typeSafeProfileRefs, ...layaProfileRefs],
  pii_semantic: ["tali.openai-compatible-pii.v1", "tali.qwen3guard.v1"],
  contextual_grounding: ["tali.grounding-judge.v1"],
  automated_reasoning: ["tali.automated-reasoning.v1"],
} as const satisfies Record<ModelCapabilityId, readonly string[]>;

// Preference is protocol specificity, not a model-quality score. A single
// registered model can implement several bindings when its profile conforms to
// every selected capability contract.
export const capabilityProfilePreference = {
  classifier_review: ["tali.classifier-review.v1"],
  content_safety: [
    "tali.nemotron-safety-guard-v3.v1",
    "tali.nemotron-content-safety.v1",
    "tali.llama-guard-3.v1",
    "tali.qwen3guard.v1",
    "tali.typesafe-jev.v1",
    "tali.laya.v1",
  ],
  jailbreak: [
    "tali.typesafe-jev.v1",
    "tali.laya.v1",
    "tali.nemoguard-jailbreak-detect.v1",
    "tali.openai-compatible-jailbreak.v1",
    "tali.qwen3guard.v1",
  ],
  topic_control: ["tali.nemoguard-topic-control.v1", "tali.taxonomy-judge.v1", ...typeSafeProfileRefs, ...layaProfileRefs],
  pii_semantic: ["tali.openai-compatible-pii.v1", "tali.qwen3guard.v1"],
  contextual_grounding: ["tali.grounding-judge.v1"],
  automated_reasoning: ["tali.automated-reasoning.v1"],
} as const satisfies Record<ModelCapabilityId, readonly string[]>;

export type CapabilityBindingId =
  | "classifier_review.input"
  | "content_safety.input"
  | "content_safety.output"
  | "jailbreak.input"
  | "topic_control.input"
  | "pii_semantic.input"
  | "pii_semantic.output"
  | "contextual_grounding.output"
  | "automated_reasoning.output";

export type CapabilityBindingDefinition = {
  id: CapabilityBindingId;
  categoryId: GuardrailCategoryId;
  capabilityRef: ModelCapabilityId;
  railType: ImplementedGuardrailRailType;
  implementationRef: string;
  contractRefs: readonly string[];
  profileRefs: readonly string[];
  profilePreference: readonly string[];
};

const binding = (definition: CapabilityBindingDefinition): CapabilityBindingDefinition => definition;

/**
 * Runtime-backed Input/Output capability surfaces. Future Rail manifests can
 * append bindings without changing Provider, Model, Policy, or Guardrail
 * ownership. The binding ID is stable persisted configuration identity.
 */
export const capabilityBindingDefinitions = [
  binding({
    id: "classifier_review.input", categoryId: "content_safety", capabilityRef: "classifier_review", railType: "input",
    implementationRef: "tali.runtime.classifier-review.v1", contractRefs: ["tali.guard.classifier-review.v1"],
    profileRefs: capabilityProfileRefs.classifier_review, profilePreference: capabilityProfilePreference.classifier_review,
  }),
  binding({
    id: "content_safety.input", categoryId: "content_safety", capabilityRef: "content_safety", railType: "input",
    implementationRef: "tali.runtime.safety-model.v1", contractRefs: ["tali.guard.content-safety.v1"],
    profileRefs: capabilityProfileRefs.content_safety, profilePreference: capabilityProfilePreference.content_safety,
  }),
  binding({
    id: "content_safety.output", categoryId: "content_safety", capabilityRef: "content_safety", railType: "output",
    implementationRef: "tali.runtime.safety-model.v1", contractRefs: ["tali.guard.content-safety.v1"],
    profileRefs: capabilityProfileRefs.content_safety.filter(profile => profile !== "tali.typesafe-jev.v1" && profile !== "tali.laya.v1"),
    profilePreference: capabilityProfilePreference.content_safety.filter(profile => profile !== "tali.typesafe-jev.v1" && profile !== "tali.laya.v1"),
  }),
  binding({
    id: "jailbreak.input", categoryId: "jailbreak_protection", capabilityRef: "jailbreak", railType: "input",
    implementationRef: "tali.runtime.safety-model.v1", contractRefs: ["tali.guard.jailbreak.v1"],
    profileRefs: capabilityProfileRefs.jailbreak, profilePreference: capabilityProfilePreference.jailbreak,
  }),
  binding({
    id: "topic_control.input", categoryId: "topic_control", capabilityRef: "topic_control", railType: "input",
    implementationRef: "tali.runtime.topic-judge.v1", contractRefs: ["tali.guard.topic-control.semantic.v1"],
    profileRefs: capabilityProfileRefs.topic_control, profilePreference: capabilityProfilePreference.topic_control,
  }),
  binding({
    id: "pii_semantic.input", categoryId: "pii_detection", capabilityRef: "pii_semantic", railType: "input",
    implementationRef: "tali.runtime.safety-model.v1", contractRefs: ["tali.guard.pii.semantic.v1"],
    profileRefs: capabilityProfileRefs.pii_semantic, profilePreference: capabilityProfilePreference.pii_semantic,
  }),
  binding({
    id: "pii_semantic.output", categoryId: "pii_detection", capabilityRef: "pii_semantic", railType: "output",
    implementationRef: "tali.runtime.safety-model.v1", contractRefs: ["tali.guard.pii.semantic.v1"],
    profileRefs: capabilityProfileRefs.pii_semantic, profilePreference: capabilityProfilePreference.pii_semantic,
  }),
  binding({
    id: "contextual_grounding.output", categoryId: "hallucinations_fact_checking", capabilityRef: "contextual_grounding", railType: "output",
    implementationRef: "tali.runtime.grounding-judge.v1", contractRefs: ["tali.guard.contextual-grounding.v1"],
    profileRefs: capabilityProfileRefs.contextual_grounding, profilePreference: capabilityProfilePreference.contextual_grounding,
  }),
  binding({
    id: "automated_reasoning.output", categoryId: "hallucinations_fact_checking", capabilityRef: "automated_reasoning", railType: "output",
    implementationRef: "tali.runtime.automated-reasoning.v1", contractRefs: ["tali.guard.automated-reasoning.v1"],
    profileRefs: capabilityProfileRefs.automated_reasoning, profilePreference: capabilityProfilePreference.automated_reasoning,
  }),
] as const satisfies readonly CapabilityBindingDefinition[];

export const capabilityBindingIds = capabilityBindingDefinitions.map((item) => item.id) as [CapabilityBindingId, ...CapabilityBindingId[]];
export const capabilityBindingById = new Map<CapabilityBindingId, CapabilityBindingDefinition>(
  capabilityBindingDefinitions.map((item) => [item.id, item]),
);

export const localCapabilitySurfaces = [
  { id: "secrets_exact.input", categoryId: "pii_detection", capabilityRef: "secrets", railType: "input", contractRef: "tali.guard.secrets.exact.v1" },
  { id: "secrets_exact.output", categoryId: "pii_detection", capabilityRef: "secrets", railType: "output", contractRef: "tali.guard.secrets.exact.v1" },
  { id: "pii_exact.input", categoryId: "pii_detection", capabilityRef: "pii", railType: "input", contractRef: "tali.guard.pii.exact.v1" },
  { id: "pii_exact.output", categoryId: "pii_detection", capabilityRef: "pii", railType: "output", contractRef: "tali.guard.pii.exact.v1" },
  { id: "prompt_injection.input", categoryId: "jailbreak_protection", capabilityRef: "prompt_injection", railType: "input", contractRef: "tali.guard.prompt-injection.v1" },
  { id: "indirect_prompt_injection.input", categoryId: "jailbreak_protection", capabilityRef: "indirect_prompt_injection", railType: "input", contractRef: "tali.guard.indirect-prompt-injection.v1" },
  { id: "memory_poisoning.input", categoryId: "agentic_security", capabilityRef: "memory_poisoning", railType: "input", contractRef: "tali.guard.memory-poisoning.v1" },
  { id: "system_prompt_leakage.output", categoryId: "pii_detection", capabilityRef: "system_prompt_leakage", railType: "output", contractRef: "tali.guard.system-prompt-leakage.v1" },
  { id: "content_filter.input", categoryId: "content_safety", capabilityRef: "content_filter", railType: "input", contractRef: "tali.guard.content-filter.rules.v1" },
  { id: "content_filter.output", categoryId: "content_safety", capabilityRef: "content_filter", railType: "output", contractRef: "tali.guard.content-filter.rules.v1" },
] as const satisfies ReadonlyArray<{
  id: string;
  categoryId: GuardrailCategoryId;
  capabilityRef: string;
  railType: ImplementedGuardrailRailType;
  contractRef: string;
}>;

export const defaultGuardrailCategory: GuardrailCategoryId = "agentic_security";

export function isGuardrailCategoryId(value: string): value is GuardrailCategoryId {
  return (guardrailCategoryIds as readonly string[]).includes(value);
}
