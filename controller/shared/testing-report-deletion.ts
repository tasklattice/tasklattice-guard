export type TestingReportDeletionImpact = {
  runId: string;
  guardrailId: string;
  version: string;
  deletable: boolean;
  running: boolean;
};
