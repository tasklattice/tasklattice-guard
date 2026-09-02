import { z } from "zod";

export const modelProviderKinds = [
  "openai",
  "qwen",
  "deepseek",
  "vllm",
  "ollama",
  "custom-openai-compatible",
] as const;

export const modelProfiles = [
  "generic-chat",
  "tali.qwen3guard.v1",
  "tali.llama-guard-3.v1",
  "tali.nemotron-content-safety.v1",
  "tali.nemotron-safety-guard-v3.v1",
  "tali.nemoguard-topic-control.v1",
  "tali.nemotron-nano-jailbreak.v1",
  "tali.taxonomy-judge.v1",
  "tali.grounding-judge.v1",
  "tali.automated-reasoning.v1",
] as const;

export const modelRoles = [
  "control_plane",
  "safety_evaluator",
  "jailbreak_evaluator",
  "topic_policy_judge",
  "grounding_judge",
  "automated_reasoning",
] as const;

export type ModelProviderKind = (typeof modelProviderKinds)[number];
export type ModelProfile = (typeof modelProfiles)[number];
export type ModelRole = (typeof modelRoles)[number];
export type ModelResourceStatus = "pending" | "validated" | "failed";
export type ModelRevisionState = "draft" | "validated" | "activating" | "active" | "superseded" | "failed";

export type ModelAssignments = Record<ModelRole, string | null>;

export const emptyModelAssignments = (): ModelAssignments => ({
  control_plane: null,
  safety_evaluator: null,
  jailbreak_evaluator: null,
  topic_policy_judge: null,
  grounding_judge: null,
  automated_reasoning: null,
});

export const providerInputSchema = z.object({
  name: z.string().trim().min(3).max(80),
  kind: z.enum(modelProviderKinds),
  baseUrl: z.string().trim().url(),
  apiKey: z.string().max(8_192).optional().default(""),
});

export const providerUpdateSchema = providerInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "Provide at least one Provider field to update.",
);

export const modelInputSchema = z.object({
  providerId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  model: z.string().trim().min(1).max(256),
  profile: z.enum(modelProfiles).default("generic-chat"),
  timeoutSeconds: z.number().int().min(1).max(120).default(20),
  maxTokens: z.number().int().min(1).max(32_768).default(512),
});

export const assignmentInputSchema = z.object(
  Object.fromEntries(modelRoles.map((role) => [role, z.string().uuid().nullable()])) as {
    [Role in ModelRole]: z.ZodNullable<z.ZodString>;
  },
);

export const profileContracts: Record<ModelProfile, readonly string[]> = {
  "generic-chat": [],
  "tali.qwen3guard.v1": [
    "tali.guard.content-safety.v1",
    "tali.guard.jailbreak.v1",
    "tali.guard.pii.semantic.v1",
  ],
  "tali.llama-guard-3.v1": ["tali.guard.content-safety.v1"],
  "tali.nemotron-content-safety.v1": ["tali.guard.content-safety.v1"],
  "tali.nemotron-safety-guard-v3.v1": ["tali.guard.content-safety.v1"],
  "tali.nemoguard-topic-control.v1": [
    "tali.guard.topic-control.semantic.v1",
    "tali.guard.company-policy.v1",
  ],
  "tali.nemotron-nano-jailbreak.v1": ["tali.guard.jailbreak.v1"],
  "tali.taxonomy-judge.v1": [
    "tali.guard.taxonomy-normalization.v1",
    "tali.guard.topic-control.semantic.v1",
    "tali.guard.company-policy.v1",
  ],
  "tali.grounding-judge.v1": ["tali.guard.contextual-grounding.v1"],
  "tali.automated-reasoning.v1": ["tali.guard.automated-reasoning.v1"],
};

export const roleProfiles: Record<ModelRole, readonly ModelProfile[]> = {
  control_plane: ["generic-chat"],
  safety_evaluator: [
    "tali.qwen3guard.v1",
    "tali.llama-guard-3.v1",
    "tali.nemotron-content-safety.v1",
    "tali.nemotron-safety-guard-v3.v1",
  ],
  jailbreak_evaluator: ["tali.qwen3guard.v1", "tali.nemotron-nano-jailbreak.v1"],
  topic_policy_judge: ["tali.taxonomy-judge.v1", "tali.nemoguard-topic-control.v1"],
  grounding_judge: ["tali.grounding-judge.v1"],
  automated_reasoning: ["tali.automated-reasoning.v1"],
};

export function normalizeModelAssignments(
  value: Partial<Record<ModelRole, string | null>> & {
    policy_authoring?: string | null;
    playground_chat?: string | null;
  } | null | undefined,
): ModelAssignments {
  const source = value ?? {};
  return {
    control_plane: source.control_plane ?? source.policy_authoring ?? source.playground_chat ?? null,
    safety_evaluator: source.safety_evaluator ?? null,
    jailbreak_evaluator: source.jailbreak_evaluator ?? null,
    topic_policy_judge: source.topic_policy_judge ?? null,
    grounding_judge: source.grounding_judge ?? null,
    automated_reasoning: source.automated_reasoning ?? null,
  };
}

export function assignmentContracts(
  role: ModelRole,
  profile: ModelProfile,
  assignments: ModelAssignments,
): readonly string[] {
  const contracts = profileContracts[profile];
  if (role === "jailbreak_evaluator") {
    return contracts.filter((contract) => contract === "tali.guard.jailbreak.v1");
  }
  if (role === "safety_evaluator" && assignments.jailbreak_evaluator) {
    return contracts.filter((contract) => contract !== "tali.guard.jailbreak.v1");
  }
  return contracts;
}

export const localCapabilityContracts = [
  "tali.guard.secrets.exact.v1",
  "tali.guard.pii.exact.v1",
  "tali.guard.content-filter.rules.v1",
  "tali.guard.prompt-injection.v1",
  "tali.guard.indirect-prompt-injection.v1",
  "tali.guard.system-prompt-leakage.v1",
  "tali.guard.topic-control.rules.v1",
] as const;

export type ModelValidationCheck = {
  id: string;
  scope: "configuration" | "provider" | "model" | "capability";
  status: "passed" | "failed" | "skipped";
  message: string;
  latencyMs?: number;
};

export type PolicyCoverage = {
  id: string;
  name: string;
  status: "ready" | "blocked";
  missingContracts: string[];
};

export type ModelValidationReport = {
  valid: boolean;
  checkedAt: string;
  checks: ModelValidationCheck[];
  capabilities: Array<{
    contract: string;
    source: "local" | "model";
    modelId: string | null;
  }>;
  policies: PolicyCoverage[];
};

export type ActiveModelRuntime = {
  id: string;
  providerId: string;
  providerName: string;
  baseUrl: string;
  credentialRef: string;
  model: string;
  profile: ModelProfile;
  timeoutSeconds: number;
  maxTokens: number;
};

export type ActiveModelConfiguration = {
  revisionId: string;
  revision: number;
  generation: number | null;
  assignments: ModelAssignments;
  models: ActiveModelRuntime[];
};
