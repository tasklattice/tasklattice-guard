import { and, asc, count, desc, eq, gte, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { auditQuerySchema, type AuditQuery } from "../../shared/audit-query.js";
import type { ControllerDatabase } from "../db/client.js";
import { currentProjectId } from "./project-context.js";
import { boundedRead } from "../db/read-budget.js";
import { auditEvents } from "../db/schema.js";

export async function queryAuditEvents(db: ControllerDatabase, input: Partial<AuditQuery> = {}) {
  const query = auditQuerySchema.parse(input);
  const before = query.before ?? new Date().toISOString();
  const conditions: SQL[] = [lte(auditEvents.occurredAt, new Date(before))];
  const projectId = currentProjectId();
  if (projectId) conditions.push(eq(auditEvents.projectId, projectId));
  if (query.window !== "all") {
    const duration = { "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 }[query.window];
    conditions.push(gte(auditEvents.occurredAt, new Date(Date.parse(before) - duration)));
  }
  const timeScope = and(...conditions);
  if (query.actor !== "all") conditions.push(query.actor === "system" ? isNull(auditEvents.actorId) : isNotNull(auditEvents.actorId));
  if (query.kind) conditions.push(eq(auditEvents.kind, query.kind));
  if (query.resourceType) conditions.push(eq(auditEvents.resourceType, query.resourceType));
  // Literal substring search: %, _ and quotes never become SQL patterns/code.
  if (query.q) conditions.push(sql`strpos(lower(concat_ws(' ', ${auditEvents.kind}, coalesce(${auditEvents.actorId}, 'system'), ${auditEvents.resourceType}, ${auditEvents.resourceId}, ${auditEvents.detail}::text)), ${query.q.toLowerCase()}) > 0`);
  const where = and(...conditions);
  return boundedRead(db, async (tx, execute) => {
    const [summary] = await execute(tx.select({ total: count() }).from(auditEvents).where(where));
    const total = summary?.total ?? 0;
    const page = Math.min(query.page, Math.max(1, Math.ceil(total / query.limit)));
    const items = await execute(tx.select().from(auditEvents).where(where)
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
      .limit(query.limit).offset((page - 1) * query.limit));
    const kinds = await execute(tx.selectDistinct({ value: auditEvents.kind }).from(auditEvents).where(timeScope).orderBy(asc(auditEvents.kind)));
    const resources = await execute(tx.selectDistinct({ value: auditEvents.resourceType }).from(auditEvents).where(timeScope).orderBy(asc(auditEvents.resourceType)));
    return { items, total, page, limit: query.limit, before, facets: { kinds: kinds.map(row => row.value), resourceTypes: resources.map(row => row.value) } };
  });
}
