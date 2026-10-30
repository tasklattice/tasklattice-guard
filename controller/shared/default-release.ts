/** Previous audit provenance; never publication eligibility or proof of a pass. */
export type DefaultTestWaiver = {
  id: string;
  reason: string;
  actorId: string;
  createdAt: string;
  contentDigest: string;
  testSuiteDigest: string;
  sourceRunId: string;
  sourceTestStatus: "passed" | "failed";
  sourceTestMetrics: Record<string, number>;
  latestVersionRunId: string | null;
  latestVersionTestStatus: "passed" | "failed" | null;
};
