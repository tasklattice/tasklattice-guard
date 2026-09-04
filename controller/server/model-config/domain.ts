import { z } from "zod";

import {
  controlPlaneProfileRefs,
  detectorProfileRefs,
  modelDetectorTypes,
  type ModelDetectorType,
} from "../../shared/guardrail-catalog.js";

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
  "tali.openai-compatible-jailbreak.v1",
  "tali.nemoguard-jailbreak-detect.v1",
  "tali.taxonomy-judge.v1",
  "tali.grounding-judge.v1",
  "tali.automated-reasoning.v1",
] as const;

export type ModelProviderKind = (typeof modelProviderKinds)[number];
export type ModelProfile = (typeof modelProfiles)[number];
export type { ModelDetectorType };
export type ModelTransport = "openai_chat" | "nemoguard_jailbreak_detect";
export type ModelResourceStatus = "pending" | "validated" | "failed";
export type ModelRevisionState = "draft" | "validated" | "activating" | "active" | "superseded" | "failed";

export const retiredModelIds = new Set(["nvidia/nvidia-nemotron-nano-9b-v2"]);

export function isRetiredModel(modelId: string): boolean {
  return retiredModelIds.has(modelId.trim().toLowerCase());
}

export type ModelAssignments = {
  controlPlane: string | null;
  detectors: Record<ModelDetectorType, string | null>;
};

export const emptyModelAssignments = (): ModelAssignments => ({
  controlPlane: null,
  detectors: Object.fromEntries(modelDetectorTypes.map((type) => [type, null])) as Record<ModelDetectorType, null>,
});

export const providerInputSchema = z.object({
  name: z.string().trim().min(3).max(80),
  kind: z.enum(modelProviderKinds),
  baseUrl: z.string().trim().url(),
  apiKey: z.string().max(8_192).optional().default(""),
  skipTlsVerify: z.boolean().default(false),
});

export const providerUpdateSchema = providerInputSchema.partial().extend({
  // PATCH must not apply creation defaults to omitted fields.
  apiKey: z.string().max(8_192).optional(),
  skipTlsVerify: z.boolean().optional(),
}).refine(
  (value) => Object.keys(value).length > 0,
  "Provide at least one Provider field to update.",
);

const modelInputObjectSchema = z.object({
  providerId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  model: z.string().trim().min(1).max(256),
  profile: z.enum(modelProfiles).default("generic-chat"),
  timeoutSeconds: z.number().int().min(1).max(120).default(20),
  maxTokens: z.number().int().min(1).max(32_768).default(512),
});

export const modelInputSchema = modelInputObjectSchema.refine((input) => !isRetiredModel(input.model), {
  message: "This Model has been retired and cannot be registered.", path: ["model"],
});

export const modelConfigurationInputSchema = modelInputObjectSchema.pick({
  profile: true, timeoutSeconds: true, maxTokens: true,
});

export const providerRegistrationSchema = z.object({
  connection: providerInputSchema,
  models: z.array(modelInputObjectSchema.omit({ providerId: true }).refine((input) => !isRetiredModel(input.model), {
    message: "This Model has been retired and cannot be registered.", path: ["model"],
  })).min(1).max(50),
}).refine((input) => new Set(input.models.map((model) => model.model)).size === input.models.length, {
  message: "Select each Model only once.", path: ["models"],
});

export const assignmentInputSchema = z.object({
  controlPlane: z.string().uuid().nullable(),
  detectors: z.object(
    Object.fromEntries(modelDetectorTypes.map((type) => [type, z.string().uuid().nullable()])) as {
      [Type in ModelDetectorType]: z.ZodNullable<z.ZodString>;
    },
  ),
});

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
  "tali.openai-compatible-jailbreak.v1": ["tali.guard.jailbreak.v1"],
  "tali.nemoguard-jailbreak-detect.v1": ["tali.guard.jailbreak.v1"],
  "tali.taxonomy-judge.v1": [
    "tali.guard.taxonomy-normalization.v1",
    "tali.guard.topic-control.semantic.v1",
    "tali.guard.company-policy.v1",
  ],
  "tali.grounding-judge.v1": ["tali.guard.contextual-grounding.v1"],
  "tali.automated-reasoning.v1": ["tali.guard.automated-reasoning.v1"],
};

export const profileTransports: Record<ModelProfile, ModelTransport> = {
  "generic-chat": "openai_chat",
  "tali.qwen3guard.v1": "openai_chat",
  "tali.llama-guard-3.v1": "openai_chat",
  "tali.nemotron-content-safety.v1": "openai_chat",
  "tali.nemotron-safety-guard-v3.v1": "openai_chat",
  "tali.nemoguard-topic-control.v1": "openai_chat",
  "tali.openai-compatible-jailbreak.v1": "openai_chat",
  "tali.nemoguard-jailbreak-detect.v1": "nemoguard_jailbreak_detect",
  "tali.taxonomy-judge.v1": "openai_chat",
  "tali.grounding-judge.v1": "openai_chat",
  "tali.automated-reasoning.v1": "openai_chat",
};

export const controlPlaneProfiles: readonly ModelProfile[] = controlPlaneProfileRefs;

export const detectorProfiles = detectorProfileRefs as Record<ModelDetectorType, readonly ModelProfile[]>;

export function normalizeModelAssignments(
  value: Partial<{
    controlPlane: string | null;
    detectors: Partial<Record<ModelDetectorType, string | null>>;
  }> | null | undefined,
): ModelAssignments {
  const source = value ?? {};
  return {
    controlPlane: source.controlPlane ?? null,
    detectors: Object.fromEntries(modelDetectorTypes.map((type) => [type, source.detectors?.[type] ?? null])) as Record<ModelDetectorType, string | null>,
  };
}

export function detectorContracts(
  detectorType: ModelDetectorType,
  profile: ModelProfile,
): readonly string[] {
  const contracts = profileContracts[profile];
  const allowed: Record<ModelDetectorType, readonly string[]> = {
    content_safety: ["tali.guard.content-safety.v1"],
    jailbreak_detection: ["tali.guard.jailbreak.v1"],
    topic_control: ["tali.guard.topic-control.semantic.v1", "tali.guard.company-policy.v1"],
    pii_detection: ["tali.guard.pii.semantic.v1"],
    contextual_grounding: ["tali.guard.contextual-grounding.v1"],
    automated_reasoning: ["tali.guard.automated-reasoning.v1"],
  };
  return contracts.filter((contract) => allowed[detectorType].includes(contract));
}

export function assignedModelIds(assignments: ModelAssignments): string[] {
  return [
    assignments.controlPlane,
    ...Object.values(assignments.detectors),
  ].filter((value): value is string => Boolean(value));
}

export function detectorUsesModel(assignments: ModelAssignments, detectorType: ModelDetectorType, modelId: string): boolean {
  return assignments.detectors[detectorType] === modelId;
}

export function assignmentTargetProfiles(target: "control_plane" | ModelDetectorType): readonly ModelProfile[] {
  if (target === "control_plane") {
    return controlPlaneProfiles;
  }
  return detectorProfiles[target];
}

export const localGuardrailContracts = [
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
  scope: "configuration" | "provider" | "model" | "detector";
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
  contractCoverage: Array<{
    contract: string;
    source: "local" | "model";
    modelId: string | null;
    detectorType: ModelDetectorType | null;
  }>;
  policies: PolicyCoverage[];
};

export type ActiveModelRuntime = {
  id: string;
  providerId: string;
  providerName: string;
  baseUrl: string;
  credentialRef: string;
  skipTlsVerify?: boolean;
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
