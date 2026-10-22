import { currentTenantId, resourceWritePredicate } from "./tenant-context.js";
import { createHash } from "node:crypto";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { SecurityEventPage, SecurityEventRecord, SecurityEventsQuery } from "../../shared/security-events.js";
import type { ControllerDatabase } from "../db/client.js";
import { boundedRead } from "../db/read-budget.js";
import { runtimeEvents } from "../db/schema.js";
import { asText, findingSeverity, jsonArray, jsonObject, jsonText, jsonValue, securityFinding, timestampValue } from "../db/postgres-expressions.js";
import { ValidationError } from "../domain/errors.js";
import { metricWindows } from "./runtime-metric-results.js";

const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)));
const cursorSchema = z.object({
  version: z.literal(1), scope: z.string(), since: timestamp, until: timestamp,
  at: timestamp, id: z.string().min(1).max(256), ordinal: z.number().int().positive(),
});

export async function querySecurityEvents(db: ControllerDatabase, input: SecurityEventsQuery): Promise<SecurityEventPage> {
  const query = input;
  const scope = createHash("sha256").update(JSON.stringify([currentTenantId(), query.guardrailId, query.window, query.limit, query.severity ?? []])).digest("hex");
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor) {
    try {
      cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString()));
      if (cursor.scope !== scope || (query.until && Date.parse(query.until) !== Date.parse(cursor.until))) throw new Error();
      if (Date.parse(cursor.since) !== Date.parse(cursor.until) - metricWindows[query.window]) throw new Error();
    } catch { throw new ValidationError("Invalid Security Event cursor or filter scope"); }
  }
  const until = cursor?.until ?? query.until ?? new Date().toISOString();
  const since = cursor?.since ?? new Date(Date.parse(until) - metricWindows[query.window]).toISOString();
  const finding = sql`f.item`;
  const ordinal = sql<number>`f.ordinal`;
  const predicate = and(
    resourceWritePredicate(runtimeEvents.tenantId),
    eq(runtimeEvents.guardrailId, query.guardrailId),
    gte(runtimeEvents.occurredAt, new Date(since)),
    lte(runtimeEvents.occurredAt, new Date(until)),
    // A later ingestion with an old occurrence timestamp must not enter this browsing session.
    lte(runtimeEvents.receivedAt, new Date(until)),
    // Seek the checkpoint index before expanding findings on deeper pages.
    cursor ? sql`(${runtimeEvents.occurredAt}, ${runtimeEvents.id}) <= (${timestampValue(cursor.at)}, ${cursor.id})` : undefined,
    securityFinding(finding),
    query.severity?.length ? inArray(findingSeverity(finding), query.severity) : undefined,
    cursor ? sql`(${runtimeEvents.occurredAt}, ${runtimeEvents.id}, ${ordinal}) < (${timestampValue(cursor.at)}, ${cursor.id}, ${cursor.ordinal}::bigint)` : undefined,
  );
  // Only bounded finding metadata crosses the DB/Node boundary; bodies, traces and evidence stay in storage.
  const projection = jsonObject(Object.fromEntries(["risk", "verdict", "confidence", "taxonomyId", "recommendedAction", "policyId", "ruleId", "riskSeverity", "policyVersion"].map(key => [key, jsonValue(finding, key)])));
  const rows = await boundedRead(db, async (tx, execute) => {
    const result = await execute(tx.execute<SecurityEventRecord & { cursorAt: string }>(sql`
      SELECT ${runtimeEvents.id} AS "eventId", ${ordinal}::integer AS "findingIndex",
        ${asText(runtimeEvents.occurredAt)} AS "cursorAt", ${runtimeEvents.occurredAt} AS "occurredAt",
        ${runtimeEvents.requestId} AS "requestId", ${runtimeEvents.guardrailId} AS "guardrailId",
        ${runtimeEvents.guardrailVersion} AS "guardrailVersion", ${runtimeEvents.routerId} AS "routerId",
        ${runtimeEvents.endpointId} AS "endpointId", ${runtimeEvents.direction} AS "direction",
        ${runtimeEvents.decision} AS "decision", ${jsonText(runtimeEvents.metadata, "protocol")} AS "protocol",
        ${jsonText(runtimeEvents.metadata, "action")} AS "action", ${projection} AS "finding"
      FROM ${runtimeEvents}
      CROSS JOIN LATERAL jsonb_array_elements(${jsonArray(jsonValue(runtimeEvents.metadata, "findings"))}) WITH ORDINALITY AS f(item, ordinal)
      WHERE ${predicate}
      ORDER BY ${runtimeEvents.occurredAt} DESC, ${runtimeEvents.id} DESC, ${ordinal} DESC
      LIMIT ${query.limit + 1}
    `));
    return result.rows;
  });
  const items = rows.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items: items.map(({ cursorAt: _at, ...item }) => ({ ...item, occurredAt: new Date(item.occurredAt).toISOString() })),
    count: items.length, since, until,
    nextCursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify({
      version: 1, scope, since, until, at: last.cursorAt, id: last.eventId, ordinal: last.findingIndex,
    })).toString("base64url") : null,
  };
}
