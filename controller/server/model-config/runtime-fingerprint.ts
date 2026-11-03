import { createHash } from "node:crypto";
import { canonicalJson } from "../../shared/canonical-json.js";
import type { ModelAssignments } from "./domain.js";

type Model = { id: string; tenantId?: string | null; providerId: string; model: string; profile: string; timeoutSeconds: number; maxTokens: number };
type Provider = { id: string; kind: string; baseUrl: string; skipTlsVerify: boolean; credentialCiphertext: string };

/** Validation authority excludes mutable display/health metadata and Controller
 * chat assignment. Credential rotation and runtime/protocol edits invalidate it. */
export function modelRuntimeValidationFingerprint(assignments: ModelAssignments, models: readonly Model[], providers: readonly Provider[]): string {
  const ids = new Set(Object.values(assignments.bindings).filter((id): id is string => Boolean(id)));
  const selected = models.filter(model => ids.has(model.id)).sort((a, b) => a.id.localeCompare(b.id));
  const providerIds = new Set(selected.map(model => model.providerId));
  const snapshot = { bindings: assignments.bindings, models: selected.map(model => ({ id: model.id,
    tenantId: model.tenantId ?? null, providerId: model.providerId, model: model.model, profile: model.profile,
    timeoutSeconds: model.timeoutSeconds, maxTokens: model.maxTokens })),
    providers: providers.filter(provider => providerIds.has(provider.id)).sort((a, b) => a.id.localeCompare(b.id)).map(provider => ({
      id: provider.id, kind: provider.kind, baseUrl: provider.baseUrl, skipTlsVerify: provider.skipTlsVerify,
      credentialCiphertext: provider.credentialCiphertext,
    })) };
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

export function modelBindingValidationFingerprint(target: string, model: Model, provider: Provider): string {
  const snapshot = { target, model: { id: model.id, tenantId: model.tenantId ?? null, providerId: model.providerId,
    model: model.model, profile: model.profile, timeoutSeconds: model.timeoutSeconds, maxTokens: model.maxTokens },
    provider: { id: provider.id, kind: provider.kind, baseUrl: provider.baseUrl, skipTlsVerify: provider.skipTlsVerify,
      credentialCiphertext: provider.credentialCiphertext } };
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}
