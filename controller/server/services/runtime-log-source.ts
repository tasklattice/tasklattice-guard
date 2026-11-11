import { resourceWritePredicate } from "./project-context.js";
import { and, desc, eq, getTableColumns, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { ControllerDatabase } from "../db/client.js";
import { routeAssignments, runtimeEvents } from "../db/schema.js";

const callFailure = and(
  eq(routeAssignments.assignmentStatus, "assigned"),
  isNotNull(routeAssignments.completedAt),
  inArray(routeAssignments.outcome, ["error", "timeout"]),
);

// Read failures from their authoritative call records, including inferred
// timeouts. Do not manufacture Runner checkpoints or duplicate storage.
export function callFailureEvents(db: ControllerDatabase) {
  return db.select({
    id: sql<string>`'call:' || ${routeAssignments.decisionId}`.as("id"),
    projectId: routeAssignments.projectId,
    // Monitoring scopes calls by assignment time, including late completions.
    occurredAt: routeAssignments.occurredAt,
    receivedAt: sql<Date>`${routeAssignments.occurredAt}`.mapWith(routeAssignments.occurredAt).as("received_at"),
    requestId: sql<string>`${routeAssignments.callId}`.as("request_id"),
    runnerId: sql<string>`'controller'`.as("runner_id"),
    guardrailId: routeAssignments.guardrailId,
    guardrailVersion: routeAssignments.guardrailVersion,
    endpointId: routeAssignments.endpointId,
    routerId: routeAssignments.routerId,
    allocationContextId: routeAssignments.allocationContextId,
    direction: sql<string>`'completion'`.as("direction"),
    decision: sql<string>`${routeAssignments.outcome}`.as("decision"),
    durationMs: sql<number>`coalesce(${routeAssignments.durationMs}, 0)`.as("duration_ms"),
    metadata: sql<Record<string, unknown>>`jsonb_build_object(
      'logKind', 'call_completion', 'executionStatus', ${routeAssignments.outcome},
      'protocol', 'routing', 'completionInferred', ${routeAssignments.completionInferred},
      'failureReason', ${routeAssignments.failureReason}, 'completedAt', ${routeAssignments.completedAt},
      'decisionId', ${routeAssignments.decisionId}, 'routeId', ${routeAssignments.routeId},
      'targetId', ${routeAssignments.targetId}, 'routerRevision', ${routeAssignments.routerRevision},
      'timedOut', ${routeAssignments.outcome} = 'timeout', 'contentAvailable', false
    )`.as("metadata"),
  }).from(routeAssignments).where(and(callFailure, resourceWritePredicate(routeAssignments.projectId)));
}

export function runtimeLogSource(db: ControllerDatabase) {
  return unionAll(db.select(getTableColumns(runtimeEvents)).from(runtimeEvents).where(resourceWritePredicate(runtimeEvents.projectId)), callFailureEvents(db)).as("runtime_logs");
}

/** Apply the complete filter and cursor BEFORE bounding each sorted branch.
 * Bounding an unfiltered branch would hide older matches; bounding only the
 * outer UNION lets PostgreSQL scan/sort the entire failure history. The top N
 * of a union can only contain rows from the top N of either filtered branch. */
export function runtimeLogPageSource(db: ControllerDatabase, predicate: SQL | undefined, limit: number) {
  const events = db.select(getTableColumns(runtimeEvents)).from(runtimeEvents)
    .where(resourceWritePredicate(runtimeEvents.projectId)).as("runtime_logs");
  const calls = callFailureEvents(db).as("runtime_logs");
  const page = (source: typeof events | typeof calls) => db.select().from(source).where(predicate)
    .orderBy(desc(source.occurredAt), desc(source.id)).limit(limit);
  return unionAll(page(events), page(calls)).as("runtime_logs");
}
