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

export const modelDetectorTypes = [
  "content_safety",
  "jailbreak_detection",
  "topic_control",
  "pii_detection",
  "contextual_grounding",
  "automated_reasoning",
] as const;

export type ModelDetectorType = (typeof modelDetectorTypes)[number];

export const controlPlaneProfileRefs = ["generic-chat"] as const;

export const detectorProfileRefs = {
  content_safety: [
    "tali.qwen3guard.v1",
    "tali.llama-guard-3.v1",
    "tali.nemotron-content-safety.v1",
    "tali.nemotron-safety-guard-v3.v1",
  ],
  jailbreak_detection: [
    "tali.qwen3guard.v1",
    "tali.openai-compatible-jailbreak.v1",
    "tali.nemoguard-jailbreak-detect.v1",
  ],
  topic_control: ["tali.taxonomy-judge.v1", "tali.nemoguard-topic-control.v1"],
  pii_detection: ["tali.qwen3guard.v1"],
  contextual_grounding: ["tali.grounding-judge.v1"],
  automated_reasoning: ["tali.automated-reasoning.v1"],
} as const satisfies Record<ModelDetectorType, readonly string[]>;

// Preference is about protocol specificity, not model quality. Dedicated
// detector contracts are shown before multi-purpose guard protocols.
export const detectorProfilePreference = {
  content_safety: [
    "tali.nemotron-safety-guard-v3.v1",
    "tali.nemotron-content-safety.v1",
    "tali.llama-guard-3.v1",
    "tali.qwen3guard.v1",
  ],
  jailbreak_detection: [
    "tali.nemoguard-jailbreak-detect.v1",
    "tali.openai-compatible-jailbreak.v1",
    "tali.qwen3guard.v1",
  ],
  topic_control: ["tali.nemoguard-topic-control.v1", "tali.taxonomy-judge.v1"],
  pii_detection: ["tali.qwen3guard.v1"],
  contextual_grounding: ["tali.grounding-judge.v1"],
  automated_reasoning: ["tali.automated-reasoning.v1"],
} as const satisfies Record<ModelDetectorType, readonly string[]>;

export const guardrailCatalog: ReadonlyArray<{
  id: GuardrailCategoryId;
  detectors: readonly ModelDetectorType[];
}> = [
  { id: "content_safety", detectors: ["content_safety"] },
  { id: "jailbreak_protection", detectors: ["jailbreak_detection"] },
  { id: "topic_control", detectors: ["topic_control"] },
  { id: "pii_detection", detectors: ["pii_detection"] },
  { id: "agentic_security", detectors: [] },
  { id: "tool_calling", detectors: [] },
  {
    id: "hallucinations_fact_checking",
    detectors: ["contextual_grounding", "automated_reasoning"],
  },
  { id: "llm_self_check", detectors: [] },
  { id: "third_party_apis", detectors: [] },
];

export const categoryForDetector: Record<ModelDetectorType, GuardrailCategoryId> = {
  content_safety: "content_safety",
  jailbreak_detection: "jailbreak_protection",
  topic_control: "topic_control",
  pii_detection: "pii_detection",
  contextual_grounding: "hallucinations_fact_checking",
  automated_reasoning: "hallucinations_fact_checking",
};

export const defaultGuardrailCategory: GuardrailCategoryId = "agentic_security";

export function isGuardrailCategoryId(value: string): value is GuardrailCategoryId {
  return (guardrailCategoryIds as readonly string[]).includes(value);
}
