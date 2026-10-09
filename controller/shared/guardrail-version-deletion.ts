/** What still depends on one immutable Guardrail version, and what must settle before it can be deleted. */
export type GuardrailVersionReference =
  | { kind: "baseline" }
  | { kind: "router_active" | "router_draft" | "change_request" | "rollback_target"; routerId: string; routerName: string; revision?: number; changeRequestId?: string; ticket?: string };
export type GuardrailVersionDeletionBlocker = { code: "compiling" | "in_flight_calls" | "recently_served" | "runner_sync"; until?: string };
export type GuardrailVersionDeletionImpact = {
  guardrailId: string;
  version: string;
  deletable: boolean;
  references: GuardrailVersionReference[];
  blockers: GuardrailVersionDeletionBlocker[];
  /** Router revisions kept for audit that can no longer be restored once the version is deleted. */
  unrestorableRevisions: Array<{ routerId: string; routerName: string; revision: number; createdAt: string }>;
};
