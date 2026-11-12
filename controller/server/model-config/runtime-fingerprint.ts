import { createHash } from "node:crypto";
import { canonicalJson } from "../../shared/canonical-json.js";
import type { ModelAssignments } from "./domain.js";
import { builtinLaya, isBuiltinLaya } from "./builtin-laya.js";

type Model = { id: string; projectId?: string | null; providerId: string; model: string; profile: string; timeoutSeconds: number; maxTokens: number; lowerThreshold?: number; upperThreshold?: number };
type Provider = { id: string; kind: string; baseUrl: string; skipTlsVerify: boolean; credentialCiphertext: string };

/** Validation authority excludes mutable display/health metadata and Controller
 * chat assignment. Credential rotation and runtime/protocol edits invalidate it. */
export function modelRuntimeValidationFingerprint(assignments: ModelAssignments, models: readonly Model[], providers: readonly Provider[]): string {
  const ids = new Set(Object.values(assignments.bindings).filter((id): id is string => Boolean(id)));
  const selected = models.filter(model => ids.has(model.id)).sort((a, b) => a.id.localeCompare(b.id));
  const providerIds = new Set(selected.map(model => model.providerId));
  const snapshot = { bindings: assignments.bindings, models: selected.map(model => ({ id: model.id,
    projectId: model.projectId ?? null, providerId: model.providerId, model: model.model, profile: model.profile,
    timeoutSeconds: model.timeoutSeconds, maxTokens: model.maxTokens, lowerThreshold: model.lowerThreshold ?? 0.1, upperThreshold: model.upperThreshold ?? 0.9,
    ...builtinFingerprint(model) })),
    providers: providers.filter(provider => providerIds.has(provider.id)).sort((a, b) => a.id.localeCompare(b.id)).map(provider => ({
      id: provider.id, kind: provider.kind, baseUrl: provider.baseUrl, skipTlsVerify: provider.skipTlsVerify,
      credentialCiphertext: provider.credentialCiphertext,
    })) };
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

export function modelBindingValidationFingerprint(target: string, model: Model, provider: Provider): string {
  const snapshot = { target, model: { id: model.id, projectId: model.projectId ?? null, providerId: model.providerId,
    model: model.model, profile: model.profile, timeoutSeconds: model.timeoutSeconds, maxTokens: model.maxTokens, lowerThreshold: model.lowerThreshold ?? 0.1, upperThreshold: model.upperThreshold ?? 0.9,
    ...builtinFingerprint(model) },
    provider: { id: provider.id, kind: provider.kind, baseUrl: provider.baseUrl, skipTlsVerify: provider.skipTlsVerify,
      credentialCiphertext: provider.credentialCiphertext } };
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

function builtinFingerprint(model: Model) {
  return isBuiltinLaya(model.id, model.providerId)
    ? { backend: builtinLaya.backend, checkpointRevision: builtinLaya.checkpointRevision }
    : {};
}
