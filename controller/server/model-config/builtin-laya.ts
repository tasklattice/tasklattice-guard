import checkpoint from "../../shared/builtin-laya-manifest.json" with { type: "json" };

const configuredRevision = process.env.CONTROLLER_BUILTIN_LAYA_CHECKPOINT_REVISION;
if (configuredRevision && !/^[a-f0-9]{40}$/.test(configuredRevision)) {
  throw new Error("CONTROLLER_BUILTIN_LAYA_CHECKPOINT_REVISION must be a 40-character hexadecimal revision.");
}

export const builtinLaya = {
  providerId: "6d415db3-502a-4c49-8801-3c2b36e864d1",
  modelId: "29552d89-6b79-4d32-8871-09ed926d3d16",
  providerName: "Built-in",
  modelName: "Laya English",
  model: "laya-english",
  profile: "tali.laya.v1",
  backend: "builtin_laya",
  checkpointRevision: configuredRevision || checkpoint.revision,
  revisionLabel: "tasklattice.builtin-laya-revision",
} as const;

export function isBuiltinLaya(modelId: string, providerId: string): boolean {
  return modelId === builtinLaya.modelId && providerId === builtinLaya.providerId;
}
