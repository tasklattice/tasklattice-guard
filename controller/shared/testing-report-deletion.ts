import type { GuardrailVersionDeletionBlocker, GuardrailVersionReference } from "./guardrail-version-deletion.js";

export type TestingReportDeletionImpact = {
  runId: string;
  guardrailId: string;
  version: string;
  deletable: boolean;
  running: boolean;
  /** A released version losing its final matching Passed report. */
  pendingVersion: string | null;
  replacementRunId: string | null;
  references: GuardrailVersionReference[];
  blockers: GuardrailVersionDeletionBlocker[];
};
