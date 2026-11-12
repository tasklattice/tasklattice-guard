import checkpoint from "../../shared/builtin-laya-manifest.json" with { type: "json" };

export const builtinLaya = {
  providerId: "6d415db3-502a-4c49-8801-3c2b36e864d1",
  modelId: "29552d89-6b79-4d32-8871-09ed926d3d16",
  providerName: "Built-in",
  modelName: "Laya English",
  model: "laya-english",
  profile: "tali.laya.v1",
  backend: "builtin_laya",
  checkpointRevision: checkpoint.revision,
  revisionLabel: "tasklattice.builtin-laya-revision",
} as const;

export function isBuiltinLaya(modelId: string, providerId: string): boolean {
  return modelId === builtinLaya.modelId && providerId === builtinLaya.providerId;
}
