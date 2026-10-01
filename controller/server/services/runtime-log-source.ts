import { and, eq, getTableColumns, inArray, isNotNull, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { ControllerDatabase } from "../db/client.js";
import { routeAssignments, runtimeEvents } from "../db/schema.js";

const callFailure = and(
  eq(routeAssignments.assignmentStatus, "assigned"),
  isNotNull(routeAssignments.completedAt),
  inArray(routeAssignments.outcome, ["error", "timeout"]),
);

// Read failures from their authoritative call records, including historical
// inferred timeouts. Do not manufacture Runner checkpoints or duplicate storage.
export function callFailureEvents(db: ControllerDatabase) {
  return db.select({
    id: sql<string>`'call:' || ${routeAssignments.decisionId}`.as("id"),
    // Monitoring scopes calls by assignment time, including late completions.
    occurredAt: routeAssignments.occurredAt,
    receivedAt: sql<Date>`${routeAssignments.occurredAt}`.mapWith(routeAssignments.occurredAt).as("received_at"),
    requestId: routeAssignments.callId,
    runnerId: sql<string>`'controller'`.as("runner_id"),
    guardrailId: routeAssignments.guardrailId,
    guardrailVersion: routeAssignments.guardrailVersion,
    endpointId: routeAssignments.endpointId,
    routerId: routeAssignments.routerId,
    direction: sql<string>`'completion'`.as("direction"),
    decision: sql<string>`${routeAssignments.outcome}`.as("decision"),
    durationMs: sql<number>`coalesce(${routeAssignments.durationMs}, 0)`.as("duration_ms"),
    metadata: sql<Record<string, unknown>>`jsonb_build_object(
      'logKind', 'call_completion', 'executionStatus', 'error',
      'protocol', 'routing', 'completionInferred', ${routeAssignments.completionInferred},
      'failureReason', ${routeAssignments.failureReason}, 'completedAt', ${routeAssignments.completedAt},
      'decisionId', ${routeAssignments.decisionId}, 'routeId', ${routeAssignments.routeId},
      'targetId', ${routeAssignments.targetId}, 'routerRevision', ${routeAssignments.routerRevision},
      'timedOut', ${routeAssignments.outcome} = 'timeout', 'contentAvailable', false
    )`.as("metadata"),
  }).from(routeAssignments).where(callFailure);
}

export function runtimeLogSource(db: ControllerDatabase) {
  return unionAll(db.select(getTableColumns(runtimeEvents)).from(runtimeEvents), callFailureEvents(db)).as("runtime_logs");
}
