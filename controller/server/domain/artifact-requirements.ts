import { ARTIFACT_CONTENT_CONTRACT, type ArtifactContent } from "./artifact-content.js";

/**
 * What an environment must provide to serve an Artifact, derived only from
 * its signed content. It is declarative evidence for review and change
 * records; whether a Runner can actually serve the content is decided by a
 * Runner load check, never by this summary.
 */
export type ArtifactRequirements = {
  contentContract: string;
  runtime: { nemoVersion: string; runtimeProfile: string; compilerVersion: string; planCompilerVersion: string };
  actions: Array<{ name: string; version: string }>;
  models: Array<{ type: string; profile: string }>;
  evaluationContracts: Array<{ contract: string; capability: string; phases: string[] }>;
};

export function deriveRequirements(content: ArtifactContent): ArtifactRequirements {
  const manifest = content.dependencyManifest.filter(Array.isArray).map(item => item.map(String));
  const unique = <T>(items: T[], key: (item: T) => string) => [...new Map(items.map(item => [key(item), item])).values()]
    .sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0);
  const bindings = content.actionBindings.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  return {
    contentContract: ARTIFACT_CONTENT_CONTRACT,
    runtime: {
      nemoVersion: content.nemoVersion,
      runtimeProfile: content.runtimeProfile,
      compilerVersion: content.compilerVersion,
      planCompilerVersion: String(content.plan.compiler_version ?? ""),
    },
    actions: unique([
      ...manifest.filter(([kind]) => kind === "action").map(([, name = "", version = ""]) => ({ name, version })),
      ...bindings.filter(item => item.action_name).map(item => ({ name: String(item.action_name), version: String(item.action_version ?? "") })),
    ], item => `${item.name}@${item.version}`),
    models: unique(manifest.filter(([kind]) => kind === "model").map(([, type = "", profile = ""]) => ({ type, profile })), item => item.type),
    evaluationContracts: unique(bindings.filter(item => item.contract_ref).map(item => ({
      contract: String(item.contract_ref), capability: String(item.capability ?? ""),
      phases: Array.isArray(item.phases) ? item.phases.map(String).sort() : [],
    })), item => `${item.contract}|${item.capability}|${item.phases.join(",")}`),
  };
}
