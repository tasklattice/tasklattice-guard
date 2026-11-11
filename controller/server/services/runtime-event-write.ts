import { runtimeEventProjectId } from "./project-context.js";
import { and, sql } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { runtimeEvents } from "../db/schema.js";
import type { RuntimeEventInput } from "../domain/models.js";

type Writer = Pick<ControllerDatabase, "insert">;

function runtimeEventRow(event: RuntimeEventInput, authenticatedPoolId?: string) {
  return {
    id: event.id,
    projectId: runtimeEventProjectId(event, authenticatedPoolId),
    occurredAt: event.occurredAt, requestId: event.requestId,
    runnerId: event.runnerId, guardrailId: event.guardrailId ?? null,
    guardrailVersion: event.guardrailVersion ?? null, endpointId: event.endpointId ?? null,
    routerId: event.routerId ?? null, direction: event.direction,
    allocationContextId: event.allocationContextId ?? null,
    decision: event.decision, durationMs: event.durationMs, metadata: event.metadata,
  };
}

/** Preserve input order and enrichment rules while projecting ordinary telemetry
 * once per bounded upload batch, not once per event. */
export async function writeRuntimeEvents(db: Writer, events: readonly RuntimeEventInput[], authenticatedPoolId?: string) {
  let pending: RuntimeEventInput[] = [];
  const ids = new Set<string>();
  const flush = async () => {
    if (pending.length) await writeBatch(db, pending, authenticatedPoolId);
    pending = [];
    ids.clear();
  };
  for (const event of events) {
    // PostgreSQL cannot update the same row twice in one ON CONFLICT statement.
    // Splitting at duplicate IDs also preserves first-write/enrichment order.
    if (ids.has(event.id) || pending.length >= 50) await flush();
    pending.push(event);
    ids.add(event.id);
  }
  await flush();
}

/** A later checkpoint may select earlier bodies. Enrich the original event;
 * never replace its evidence, identity, timestamp, or already captured content. */
export async function writeRuntimeEvent(db: Writer, event: RuntimeEventInput, authenticatedPoolId?: string) {
  await writeBatch(db, [event], authenticatedPoolId);
}

async function writeBatch(db: Writer, events: readonly RuntimeEventInput[], authenticatedPoolId?: string) {
  const insert = db.insert(runtimeEvents).values(events.map(event => runtimeEventRow(event, authenticatedPoolId)));
  if (!events.some(event => event.metadata.runtimeLogCaptured === true)) {
    await insert.onConflictDoNothing();
    return;
  }
  await insert.onConflictDoUpdate({
    target: runtimeEvents.id,
    set: { metadata: sql`${runtimeEvents.metadata} || (SELECT jsonb_object_agg(key,value) FROM jsonb_each(excluded.metadata)
      WHERE key IN ('runtimeLogCaptured','contentCiphertext','contentCaptureStatus','callCaptureIncomplete','modelEvidenceStatus','modelEvidenceCount'))` },
    setWhere: and(
      sql`excluded.metadata->'runtimeLogCaptured' = 'true'::jsonb`,
      sql`${runtimeEvents.projectId} IS NOT DISTINCT FROM excluded.project_id`,
      // A scoped event without verified ownership must not enrich an existing
      // quarantined record from an unknown sender.
      authenticatedPoolId === undefined ? undefined : sql`excluded.project_id IS NOT NULL`,
      sql`${runtimeEvents.requestId} = excluded.request_id AND ${runtimeEvents.runnerId} = excluded.runner_id`,
      sql`${runtimeEvents.direction} = excluded.direction AND ${runtimeEvents.occurredAt} = excluded.occurred_at`,
      sql`${runtimeEvents.endpointId} IS NOT DISTINCT FROM excluded.endpoint_id`,
      sql`${runtimeEvents.allocationContextId} IS NOT DISTINCT FROM excluded.allocation_context_id`,
      sql`${runtimeEvents.guardrailId} IS NOT DISTINCT FROM excluded.guardrail_id`,
      sql`${runtimeEvents.guardrailVersion} IS NOT DISTINCT FROM excluded.guardrail_version`,
      sql`coalesce(${runtimeEvents.metadata}->>'contentCiphertext', '') = ''`,
    )!,
  });
}
