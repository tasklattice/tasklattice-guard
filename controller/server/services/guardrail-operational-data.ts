import { and, eq, inArray } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { guardrails, guardrailVersions, outboxEvents, routeAssignments, runtimeEvents, validationRuns } from "../db/schema.js";

type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];

/** Caller holds the Guardrail row lock. Definitions and audit history survive the reset. */
export async function clearGuardrailOperationalData(tx: Transaction, guardrailId: string) {
  const reports = await tx.delete(validationRuns).where(eq(validationRuns.guardrailId, guardrailId));
  const requests = await tx.delete(outboxEvents).where(and(
    eq(outboxEvents.aggregateId, guardrailId), eq(outboxEvents.kind, "guardrail.validation_requested"),
  ));
  const events = await tx.delete(runtimeEvents).where(eq(runtimeEvents.guardrailId, guardrailId));
  const calls = await tx.delete(routeAssignments).where(eq(routeAssignments.guardrailId, guardrailId));
  await tx.update(guardrailVersions).set({
    status: "pending", validationRunId: null, releasedAt: null, releasedBy: null, environmentCheck: null,
  }).where(eq(guardrailVersions.guardrailId, guardrailId));
  const resetAt = new Date();
  await tx.update(guardrails).set({ operationalResetAt: resetAt }).where(eq(guardrails.id, guardrailId));
  return {
    resetAt: resetAt.toISOString(), testingReports: reports.rowCount ?? 0,
    testRequests: requests.rowCount ?? 0, runtimeEvents: events.rowCount ?? 0, routeAssignments: calls.rowCount ?? 0,
  };
}

/** Share locks serialize ingestion with deletion/restoration; sorted locks avoid batch deadlocks. */
export async function guardrailTelemetryFilter(tx: Transaction, ids: Array<string | null | undefined>) {
  const selected = [...new Set(ids.filter((id): id is string => Boolean(id)))].sort();
  const rows = selected.length ? await tx.select({
    id: guardrails.id, deletedAt: guardrails.deletedAt, resetAt: guardrails.operationalResetAt,
  }).from(guardrails).where(inArray(guardrails.id, selected)).orderBy(guardrails.id).for("share") : [];
  const resources = new Map(rows.map(row => [row.id, row]));
  return (id: string | null | undefined, occurredAt: Date) => {
    const resource = id ? resources.get(id) : undefined;
    return !resource || (!resource.deletedAt && (!resource.resetAt || occurredAt > resource.resetAt));
  };
}
