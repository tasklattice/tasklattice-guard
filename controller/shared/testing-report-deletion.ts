import type { GuardrailVersionDeletionBlocker, GuardrailVersionReference } from "./guardrail-version-deletion.js";

export type TestingReportDeletionImpact = {
  runId: string;
  guardrailId: string;
  version: string;
  deletable: boolean;
  running: boolean;
  retainedByPlatformVersion?: boolean;
  /** Compatibility field; always null because reports do not control publication. */
  pendingVersion: string | null;
  replacementRunId: string | null;
  references: GuardrailVersionReference[];
  blockers: GuardrailVersionDeletionBlocker[];
};
