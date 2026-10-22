import { runtimeEventTenantId } from "./tenant-context.js";
import { and, eq, sql } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { runtimeEvents } from "../db/schema.js";
import type { RuntimeEventInput } from "../domain/models.js";

type Writer = Pick<ControllerDatabase, "insert">;

/** A later checkpoint may select earlier bodies. Enrich the original event;
 * never replace its evidence, identity, timestamp, or already captured content. */
export async function writeRuntimeEvent(db: Writer, event: RuntimeEventInput) {
  const insert = db.insert(runtimeEvents).values({
    id: event.id,
    tenantId: runtimeEventTenantId(event),
    occurredAt: event.occurredAt, requestId: event.requestId,
    runnerId: event.runnerId, guardrailId: event.guardrailId ?? null,
    guardrailVersion: event.guardrailVersion ?? null, endpointId: event.endpointId ?? null,
    routerId: event.routerId ?? null, direction: event.direction,
    decision: event.decision, durationMs: event.durationMs, metadata: event.metadata,
  });
  if (event.metadata.runtimeLogCaptured !== true) {
    await insert.onConflictDoNothing();
    return;
  }
  const enrichment = Object.fromEntries([
    "runtimeLogCaptured", "contentCiphertext", "contentCaptureStatus", "callCaptureIncomplete",
  ].filter(key => event.metadata[key] !== undefined).map(key => [key, event.metadata[key]]));
  await insert.onConflictDoUpdate({
    target: runtimeEvents.id,
    set: { metadata: sql`${runtimeEvents.metadata} || ${JSON.stringify(enrichment)}::jsonb` },
    setWhere: and(
      eq(runtimeEvents.requestId, event.requestId), eq(runtimeEvents.runnerId, event.runnerId),
      eq(runtimeEvents.direction, event.direction), eq(runtimeEvents.occurredAt, event.occurredAt),
      sql`${runtimeEvents.endpointId} IS NOT DISTINCT FROM ${event.endpointId ?? null}`,
      sql`${runtimeEvents.guardrailId} IS NOT DISTINCT FROM ${event.guardrailId ?? null}`,
      sql`${runtimeEvents.guardrailVersion} IS NOT DISTINCT FROM ${event.guardrailVersion ?? null}`,
      sql`coalesce(${runtimeEvents.metadata}->>'contentCiphertext', '') = ''`,
    )!,
  });
}
