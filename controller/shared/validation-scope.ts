/** Frozen test scope; never changes the publication Artifact or runtime protection. */
export type ValidationTestScope = {
  testModelRules: boolean;
  skippedRules: Array<{ policyId: string; ruleId: string; reason: string }>;
  modelInvocations: number;
  executionDigest: string;
  fullArtifactLoaded: boolean;
};
