import type { ArtifactContent } from "./artifact-content.js";

/** Compilation resolves executable content, without loading it or running tests. */
export type ArtifactCompilation = {
  guardrailId: string;
  guardrailVersion: string;
  runtimeProfile: string;
  plan: Record<string, unknown>;
};
export type ArtifactCompiler = (input: ArtifactCompilation) => Promise<ArtifactContent>;
export const OFFLINE_COMPILATION_CAPABILITY = "tasklattice.offline-compilation";
