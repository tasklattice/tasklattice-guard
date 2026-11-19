import checkpoint from "../../shared/builtin-laya-manifest.json" with { type: "json" };
import { builtinLayaModelId } from "../../shared/guardrail-catalog.js";

const configuredRevision = process.env.CONTROLLER_BUILTIN_LAYA_CHECKPOINT_REVISION;
if (configuredRevision && !/^[a-f0-9]{40}$/.test(configuredRevision)) {
  throw new Error("CONTROLLER_BUILTIN_LAYA_CHECKPOINT_REVISION must be a 40-character hexadecimal revision.");
}

export const builtinLaya = {
  providerId: "6d415db3-502a-4c49-8801-3c2b36e864d1",
  modelId: builtinLayaModelId,
  providerName: "Built-in",
  modelName: "Laya English",
  model: "laya-english",
  profile: "tali.laya.v1",
  backend: "builtin_laya",
  checkpointRevision: configuredRevision || checkpoint.revision,
  revisionLabel: "tasklattice.builtin-laya-revision",
} as const;

export const builtinLayaConfigurationId = `builtin-laya:${builtinLaya.checkpointRevision}`;

export function isBuiltinLaya(modelId: string, providerId: string): boolean {
  return modelId === builtinLaya.modelId && providerId === builtinLaya.providerId;
}
