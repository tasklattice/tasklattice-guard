/** Applied independently to each retained immutable version; unversioned history shares one separate bucket. */
export const TESTING_REPORT_RETENTION = { passed: 2, failed: 1 } as const;

/** Compact local evidence only: no results, inputs, suite or compiled Artifact. */
export type VersionTestEvidence = {
  testModelRules?: boolean;
  testScope?: import("./validation-scope.js").ValidationTestScope | null;
  id: string;
  status: "passed" | "failed";
  candidateDigest: string | null;
  testSuiteDigest: string | null;
  createdAt: string;
  completedAt: string;
};

export type VersionTestingEvidence = {
  latest?: VersionTestEvidence;
  release?: VersionTestEvidence;
};

export function latestTestEvidence<T extends VersionTestEvidence>(left: T | null | undefined, right: T | null | undefined): T | null {
  if (!left) return right ?? null;
  if (!right) return left;
  const delta = Date.parse(left.completedAt) - Date.parse(right.completedAt);
  return delta > 0 || (delta === 0 && left.id.localeCompare(right.id) > 0) ? left : right;
}

export function matchesTestEvidence(evidence: VersionTestEvidence | null | undefined, contentDigest: string | null, suiteDigest: string | null): boolean {
  return Boolean(evidence && evidence.status === "passed" && contentDigest && suiteDigest
    && evidence.candidateDigest === contentDigest && evidence.testSuiteDigest === suiteDigest);
}
