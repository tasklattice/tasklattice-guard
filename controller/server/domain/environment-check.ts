import type { ArtifactContent } from "./artifact-content.js";

/** Artifact content wrapped in this environment's delivery envelope. */
export type SignedArtifact = ArtifactContent & { id: string; generation: number; checksum: string; signature: string };

/** One pool's answer to a Runner load check. */
export type PoolAdmission = {
  poolId: string;
  runnerId: string;
  admitted: boolean;
  /** No answer (disconnected or timed out); says nothing about the content. */
  unavailable: boolean;
  reason: string;
  nemoVersion: string;
  modelRevisionId: string;
};

export type EnvironmentStatus = "compatible" | "missing" | "pending";

export type EnvironmentCheck = {
  status: EnvironmentStatus;
  checkedAt: string;
  pools: PoolAdmission[];
};

export type ArtifactAdmission = (artifact: SignedArtifact) => Promise<PoolAdmission[]>;

/**
 * Every pool receives every Router-referenced Artifact, so every pool with a
 * connected Runner must load it. A rejection anywhere means a dependency is
 * missing; no connected Runner or no answer is not yet a verdict.
 */
export function summarizeAdmissions(pools: PoolAdmission[], checkedAt = new Date()): EnvironmentCheck {
  const status: EnvironmentStatus = pools.some(item => !item.admitted && !item.unavailable) ? "missing"
    : pools.length && pools.every(item => item.admitted) ? "compatible" : "pending";
  return { status, checkedAt: checkedAt.toISOString(), pools };
}
