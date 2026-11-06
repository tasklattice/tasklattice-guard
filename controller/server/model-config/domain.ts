import { z } from "zod";

import {
  capabilityBindingById,
  capabilityBindingDefinitions,
  capabilityBindingIds,
  type CapabilityBindingId,
  controlPlaneProfileRefs,
  isDataPlaneProviderKindAllowed,
  isTypeSafeProfile,
  isLayaProfile,
} from "../../shared/guardrail-catalog.js";

export const modelProviderKinds = [
  "openai",
  "qwen",
  "typesafe",
  "laya",
  "deepseek",
  "vllm",
  "ollama",
  "custom-openai-compatible",
] as const;

export const modelProfiles = [
  "tali.classifier-review.v1",
  "generic-chat",
  "tali.qwen3guard.v1",
  "tali.llama-guard-3.v1",
  "tali.nemotron-content-safety.v1",
  "tali.nemotron-safety-guard-v3.v1",
  "tali.nemoguard-topic-control.v1",
  "tali.typesafe-jev-topic.v1",
  "tali.typesafe-jev.v1",
  "tali.laya-topic.v1",
  "tali.laya.v1",
  "tali.openai-compatible-jailbreak.v1",
  "tali.openai-compatible-pii.v1",
  "tali.nemoguard-jailbreak-detect.v1",
  "tali.taxonomy-judge.v1",
  "tali.grounding-judge.v1",
  "tali.automated-reasoning.v1",
] as const;

export type ModelProviderKind = (typeof modelProviderKinds)[number];
export type ModelProfile = (typeof modelProfiles)[number];
export type { CapabilityBindingId };
export type ModelTransport = "openai_chat" | "nemoguard_jailbreak_detect" | "typesafe_systemone" | "laya_systemone";
export type ModelResourceStatus = "pending" | "validated" | "failed";
export type ModelRevisionState = "draft" | "validated" | "activating" | "active" | "superseded" | "failed";

/** Laya System One request shapes. "native" sends max_len + head_max_len, while
 * "compatible" sends max_len only for strict wrappers such as 1Panel-dev/laya-server. */
export const layaRequestModes = ["native", "compatible"] as const;
export type LayaRequestMode = (typeof layaRequestModes)[number];

export const retiredModelIds = new Set(["nvidia/nvidia-nemotron-nano-9b-v2"]);

export function isRetiredModel(modelId: string): boolean {
  return retiredModelIds.has(modelId.trim().toLowerCase());
}

export type ModelAssignments = {
  controlPlane: string | null;
  bindings: Record<CapabilityBindingId, string | null>;
};

export const modelAssignmentTargets = ["control_plane", ...capabilityBindingIds] as const;
export type ModelAssignmentTarget = (typeof modelAssignmentTargets)[number];
export const modelAssignmentTargetSchema = z.enum(modelAssignmentTargets);

export const emptyModelAssignments = (): ModelAssignments => ({
  controlPlane: null,
  bindings: Object.fromEntries(capabilityBindingIds.map((id) => [id, null])) as Record<CapabilityBindingId, null>,
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

export const modelRuntimeSettingsObjectSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(64).default(2),
  rateLimitAttempts: z.number().int().min(1).max(10).default(3),
  lowerThreshold: z.number().min(0).max(1).default(0.1),
  upperThreshold: z.number().min(0).max(1).default(0.9),
});
const validThresholds = (value: { lowerThreshold: number; upperThreshold: number }) => value.lowerThreshold < value.upperThreshold;
const thresholdError = { message: "Lower threshold must be below upper threshold.", path: ["upperThreshold"] };

const modelInputObjectSchema = z.object({
  providerId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  model: z.string().trim().min(1).max(256),
  profile: z.enum(modelProfiles).default("generic-chat"),
  timeoutSeconds: z.number().int().min(1).max(120).default(20),
  maxTokens: z.number().int().min(1).max(32_768).default(512),
  ...modelRuntimeSettingsObjectSchema.shape,
});

export const modelInputSchema = modelInputObjectSchema.refine(validThresholds, thresholdError).refine((input) => !isRetiredModel(input.model), {
  message: "This Model has been retired and cannot be registered.", path: ["model"],
});

export const modelConfigurationInputSchema = modelInputObjectSchema.pick({
  profile: true, timeoutSeconds: true, maxTokens: true,
}).extend(modelRuntimeSettingsObjectSchema.shape).refine(validThresholds, thresholdError);

export const modelRuntimeSettingsInputSchema = modelRuntimeSettingsObjectSchema.refine(validThresholds, thresholdError);

export const providerRegistrationSchema = z.object({
  connection: providerInputSchema,
  models: z.array(modelInputObjectSchema.omit({ providerId: true }).refine(validThresholds, thresholdError).refine((input) => !isRetiredModel(input.model), {
    message: "This Model has been retired and cannot be registered.", path: ["model"],
  })).min(1).max(50),
}).refine((input) => new Set(input.models.map((model) => model.model)).size === input.models.length, {
  message: "Select each Model only once.", path: ["models"],
});

export const assignmentInputSchema = z.object({
  controlPlane: z.string().uuid().nullable(),
  bindings: z.object(
    Object.fromEntries(capabilityBindingIds.map((id) => [id, id.startsWith("classifier_review.") ? z.string().uuid().nullable().default(null) : z.string().uuid().nullable()])) as unknown as {
      [Id in CapabilityBindingId]: z.ZodType<string | null>;
    },
  ),
});

export const profileContracts: Record<ModelProfile, readonly string[]> = {
  "tali.classifier-review.v1": ["tali.guard.classifier-review.v1"],
  "generic-chat": ["tali.guard.classifier-review.v1"],
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
  ],
  "tali.typesafe-jev-topic.v1": ["tali.guard.topic-control.semantic.v1"],
  "tali.typesafe-jev.v1": ["tali.guard.topic-control.semantic.v1", "tali.guard.jailbreak.v1", "tali.guard.content-safety.v1",
                           "tali.guard.pii.semantic.v1"],
  "tali.laya-topic.v1": ["tali.guard.topic-control.semantic.v1"],
  "tali.laya.v1": ["tali.guard.topic-control.semantic.v1", "tali.guard.jailbreak.v1", "tali.guard.content-safety.v1",
                   "tali.guard.pii.semantic.v1"],
  "tali.openai-compatible-pii.v1": ["tali.guard.pii.semantic.v1"],
  "tali.openai-compatible-jailbreak.v1": ["tali.guard.jailbreak.v1"],
  "tali.nemoguard-jailbreak-detect.v1": ["tali.guard.jailbreak.v1"],
  "tali.taxonomy-judge.v1": [
    "tali.guard.taxonomy-normalization.v1",
    "tali.guard.topic-control.semantic.v1",
  ],
  "tali.grounding-judge.v1": ["tali.guard.contextual-grounding.v1"],
  "tali.automated-reasoning.v1": ["tali.guard.automated-reasoning.v1"],
};

export const profileTransports: Record<ModelProfile, ModelTransport> = {
  "tali.classifier-review.v1": "openai_chat",
  "generic-chat": "openai_chat",
  "tali.qwen3guard.v1": "openai_chat",
  "tali.llama-guard-3.v1": "openai_chat",
  "tali.nemotron-content-safety.v1": "openai_chat",
  "tali.nemotron-safety-guard-v3.v1": "openai_chat",
  "tali.nemoguard-topic-control.v1": "openai_chat",
  "tali.typesafe-jev-topic.v1": "typesafe_systemone",
  "tali.typesafe-jev.v1": "typesafe_systemone",
  "tali.laya-topic.v1": "laya_systemone",
  "tali.laya.v1": "laya_systemone",
  "tali.openai-compatible-jailbreak.v1": "openai_chat",
  "tali.openai-compatible-pii.v1": "openai_chat",
  "tali.nemoguard-jailbreak-detect.v1": "nemoguard_jailbreak_detect",
  "tali.taxonomy-judge.v1": "openai_chat",
  "tali.grounding-judge.v1": "openai_chat",
  "tali.automated-reasoning.v1": "openai_chat",
};

export const controlPlaneProfiles: readonly ModelProfile[] = controlPlaneProfileRefs;

/** The resolved request mode for Laya runtimes only; legacy NULL rows resolve to
 * the broad "compatible" shape so an older registration keeps working. */
export function resolveLayaRequestMode(
  profile: ModelProfile,
  stored: LayaRequestMode | null | undefined,
): LayaRequestMode | undefined {
  if (profileTransports[profile] !== "laya_systemone") return undefined;
  return stored === "native" || stored === "compatible" ? stored : "compatible";
}

export function normalizeModelAssignments(
  value: Partial<{
    controlPlane: string | null;
    bindings: Partial<Record<CapabilityBindingId, string | null>>;
  }> | null | undefined,
): ModelAssignments {
  const source = value ?? {};
  return {
    controlPlane: source.controlPlane ?? null,
    bindings: Object.fromEntries(capabilityBindingIds.map((id) => [id, source.bindings?.[id] ?? null])) as Record<CapabilityBindingId, string | null>,
  };
}

export function capabilityBindingContracts(
  bindingId: CapabilityBindingId,
  profile: ModelProfile,
): readonly string[] {
  const definition = capabilityBindingById.get(bindingId);
  if (!definition) return [];
  const contracts = profileContracts[profile];
  return contracts.filter((contract) => definition.contractRefs.includes(contract));
}

export function assignedModelIds(assignments: ModelAssignments): string[] {
  return [
    assignments.controlPlane,
    ...Object.values(assignments.bindings),
  ].filter((value): value is string => Boolean(value));
}

export function capabilityBindingUsesModel(assignments: ModelAssignments, bindingId: CapabilityBindingId, modelId: string): boolean {
  return assignments.bindings[bindingId] === modelId;
}

export function assignmentTargetProfiles(target: ModelAssignmentTarget): readonly ModelProfile[] {
  if (target === "control_plane") {
    return controlPlaneProfiles;
  }
  return (capabilityBindingById.get(target)?.profileRefs ?? []) as readonly ModelProfile[];
}

export function assignmentTargetAcceptsModel(
  target: ModelAssignmentTarget,
  profile: ModelProfile,
  providerKind: ModelProviderKind,
): boolean {
  return providerAcceptsProfile(providerKind, profile)
    && assignmentTargetProfiles(target).includes(profile)
    && (target === "control_plane" || isDataPlaneProviderKindAllowed(providerKind, target));
}

export function providerAcceptsProfile(providerKind: ModelProviderKind, profile: ModelProfile): boolean {
  if (providerKind === "laya" || isLayaProfile(profile)) {
    return providerKind === "laya" && isLayaProfile(profile);
  }
  if (providerKind === "typesafe" || isTypeSafeProfile(profile)) {
    return providerKind === "typesafe" && isTypeSafeProfile(profile);
  }
  return isDataPlaneProviderKindAllowed(providerKind)
    || profile === "generic-chat" || profile === "tali.classifier-review.v1"
    || profile === "tali.openai-compatible-pii.v1"
    || profile === "tali.grounding-judge.v1";
}

export { localGuardrailContracts } from "../../shared/protection-dependencies.js";

export type ModelValidationCheck = {
  id: string;
  scope: "configuration" | "provider" | "model" | "capability";
  status: "passed" | "failed" | "skipped";
  message: string;
  latencyMs?: number;
  evidenceKind?: "model-probe" | "nemo-rail-v1";
  runtimeFingerprint?: string;
  cases?: Array<{ id: string; passed: boolean; inputContent: string; outputContent: string; expectedDecision: string; actualDecision: string; reason: string }>;
};

export type PolicyCoverage = {
  id: string;
  name: string;
  status: "ready" | "blocked" | "unknown";
  dependenciesComplete: boolean;
  missingContracts: string[];
};

export type ModelValidationReport = {
  valid: boolean;
  checkedAt: string;
  runtimeFingerprint?: string;
  checks: ModelValidationCheck[];
  contractCoverage: Array<{
    contract: string;
    bindingId: CapabilityBindingId | null;
    railType: "input" | "output" | null;
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
  skipTlsVerify?: boolean;
  model: string;
  profile: ModelProfile;
  /** Present only for Laya profiles; transport detail, never part of a fingerprint. */
  layaRequestMode?: LayaRequestMode;
  timeoutSeconds: number;
  maxTokens: number;
  maxConcurrency?: number;
  rateLimitAttempts?: number;
  lowerThreshold?: number;
  upperThreshold?: number;
};

export type ActiveModelConfiguration = {
  revisionId: string;
  revision: number;
  generation: number | null;
  assignments: ModelAssignments;
  models: ActiveModelRuntime[];
};

export const capabilityBindings = capabilityBindingDefinitions;
