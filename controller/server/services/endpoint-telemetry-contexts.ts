import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { advisoryTransactionLock } from "../db/postgres-locks.js";
import { endpointTelemetryContexts as contexts } from "../db/schema.js";
import { ControllerError, ValidationError } from "../domain/errors.js";
import { defaultEndpointContextStorageLimits, validateEndpointContextStorageLimits, type EndpointContextStorageLimits } from "../endpoint-context-storage-policy.js";

type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];
type Endpoint = { endpointId: string; tenantId: string; adapter: string; trafficRouterId: string | null; verification: unknown; scanFlagOnlyDefault: boolean };
type Router = { routerId: string; revision: number; routes: Array<{ id: string; enabled: boolean; targets: Array<{ id: string; guardrailId: string; guardrailVersion: string; weightBps: number }> }> };
type Stored = typeof contexts.$inferSelect;
type Issued = typeof contexts.$inferInsert;
const storageLock = "endpoint-telemetry-context-storage";
export const endpointContextCleanupBatchSize = 128;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function authority(row: Pick<Stored, "tenantId" | "groupId" | "poolId" | "allocationEpoch" | "endpointId" | "adapter" | "verificationDigest" | "endpointSnapshotDigest" | "routerId" | "routerRevision" | "routerSnapshotDigest" | "targets">) {
  return { tenantId: row.tenantId, groupId: row.groupId, poolId: row.poolId, allocationEpoch: row.allocationEpoch,
    endpointId: row.endpointId, adapter: row.adapter, verificationDigest: row.verificationDigest,
    endpointSnapshotDigest: row.endpointSnapshotDigest, routerId: row.routerId, routerRevision: row.routerRevision,
    routerSnapshotDigest: row.routerSnapshotDigest, targets: row.targets };
}

/** Context-backed writers hold this until evidence + progress ACK commit. Acquire
 * Guardrail row locks first; never acquire allocation/generation after this. */
export async function lockEndpointTelemetryContextReaders(tx: Transaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${storageLock}))`);
}

function exhausted(scope: "context" | "pool" | "global", resource: "rows" | "payload_bytes", limit: number): never {
  throw new ControllerError("Endpoint provenance storage budget is exhausted. Retained evidence was preserved.",
    503, "endpoint_context_capacity_exhausted", { scope, resource, limit });
}

/** Caller holds allocation and generation locks. All issuance/counting/cleanup
 * shares one exclusive lifecycle lock across Controller replicas. */
export async function issueEndpointTelemetryContexts(tx: Transaction, input: {
  poolId: string; groupId: string; epoch: number; generation: number; endpoints: Endpoint[]; routers: Router[];
}, policy: EndpointContextStorageLimits = defaultEndpointContextStorageLimits): Promise<Map<string, string>> {
  const limits = validateEndpointContextStorageLimits(policy);
  if (new Set(input.endpoints.map(endpoint => endpoint.endpointId)).size !== input.endpoints.length)
    throw new ValidationError("Endpoint provenance snapshot contains duplicate Endpoint identities.");
  await advisoryTransactionLock(tx, storageLock);
  const active = await tx.select().from(contexts).where(and(eq(contexts.poolId, input.poolId), isNull(contexts.retiredAt)));
  const byEndpoint = new Map(active.map(row => [row.endpointId, row]));
  // A policy shrink may keep existing authority alive, but cannot allocate more.
  if (input.endpoints.length > Math.max(limits.maxRowsPerPool, active.length)) exhausted("pool", "rows", limits.maxRowsPerPool);
  const issued = new Map<string, string>(), pending: Issued[] = [];
  for (const endpoint of input.endpoints) {
    const router = input.routers.find(row => row.routerId === endpoint.trafficRouterId);
    const frozen = { tenantId: endpoint.tenantId, groupId: input.groupId, poolId: input.poolId,
      allocationEpoch: input.epoch, endpointId: endpoint.endpointId, adapter: endpoint.adapter,
      verificationDigest: digest(endpoint.verification), endpointSnapshotDigest: digest(endpoint),
      routerId: router?.routerId ?? null, routerRevision: router?.revision ?? null,
      routerSnapshotDigest: router ? digest(router) : null,
      targets: router?.routes.filter(route => route.enabled).flatMap(route => route.targets.filter(target => target.weightBps > 0).map(target => ({
        routeId: route.id, targetId: target.id, guardrailId: target.guardrailId, guardrailVersion: target.guardrailVersion,
      }))) ?? [] };
    const previous = byEndpoint.get(endpoint.endpointId);
    if (previous && digest(authority(previous)) === digest(frozen)) {
      issued.set(endpoint.endpointId, previous.id);
      continue;
    }
    const id = randomBytes(32).toString("base64url");
    // Each incarnation has a unique key. A retired row is never reactivated,
    // even when the same allocation/configuration is legitimately issued again.
    pending.push({ id, snapshotKey: digest({ ...frozen, id }), generation: input.generation, ...frozen });
    issued.set(endpoint.endpointId, id);
  }
  if (pending.length) {
    // Let PostgreSQL measure exactly the same logical UTF-8/jsonb payload as its
    // generated column, without inserting/retiring any authority first.
    const sizes = await tx.execute<{ id: string; bytes: string }>(sql`select item->>'id' as id,
      (128::bigint + octet_length(item->>'id') + octet_length(item->>'snapshotKey') + octet_length(item->>'tenantId')
      + octet_length(item->>'groupId') + octet_length(item->>'poolId') + octet_length(item->>'endpointId') + octet_length(item->>'adapter')
      + octet_length(item->>'verificationDigest') + octet_length(item->>'endpointSnapshotDigest')
      + octet_length(coalesce(item->>'routerId','')) + octet_length(coalesce(item->>'routerSnapshotDigest',''))
      + octet_length((item->'targets')::text))::text as bytes
      from jsonb_array_elements(${JSON.stringify(pending)}::jsonb) item`);
    const bytes = sizes.rows.map(row => Number(row.bytes));
    if (bytes.length !== pending.length || bytes.some(value => !Number.isSafeInteger(value) || value < 0))
      throw new Error("Endpoint provenance payload could not be measured.");
    if (bytes.some(value => value > limits.maxPayloadBytesPerContext)) exhausted("context", "payload_bytes", limits.maxPayloadBytesPerContext);
    await pruneUnlocked(tx);
    const [usage] = await tx.select({ rows: sql<number>`count(*)::integer`,
      bytes: sql<number>`coalesce(sum(${contexts.payloadBytes}),0)::bigint::float8`,
      poolRows: sql<number>`count(*) filter (where ${contexts.poolId} = ${input.poolId})::integer`,
      poolBytes: sql<number>`coalesce(sum(${contexts.payloadBytes}) filter (where ${contexts.poolId} = ${input.poolId}),0)::bigint::float8`,
    }).from(contexts);
    const added = bytes.reduce((sum, value) => sum + value, 0);
    if (usage!.poolRows + pending.length > limits.maxRowsPerPool) exhausted("pool", "rows", limits.maxRowsPerPool);
    if (usage!.rows + pending.length > limits.maxRowsGlobal) exhausted("global", "rows", limits.maxRowsGlobal);
    if (usage!.poolBytes + added > limits.maxPayloadBytesPerPool) exhausted("pool", "payload_bytes", limits.maxPayloadBytesPerPool);
    if (usage!.bytes + added > limits.maxPayloadBytesGlobal) exhausted("global", "payload_bytes", limits.maxPayloadBytesGlobal);
  }
  const reused = [...issued.values()].filter(id => active.some(row => row.id === id));
  await tx.update(contexts).set({ retiredAt: sql`clock_timestamp()` }).where(and(eq(contexts.poolId, input.poolId),
    isNull(contexts.retiredAt), reused.length ? notInArray(contexts.id, reused) : undefined));
  if (pending.length) await tx.insert(contexts).values(pending);
  return issued;
}

/** Preserve old authorization for bounded delayed replay; never rewrite owner. */
export async function retireEndpointTelemetryContexts(tx: Transaction, poolIds: readonly string[]): Promise<void> {
  if (!poolIds.length) return;
  await advisoryTransactionLock(tx, storageLock);
  await tx.update(contexts).set({ retiredAt: sql`clock_timestamp()` })
    .where(and(inArray(contexts.poolId, [...poolIds]), isNull(contexts.retiredAt)));
}

/** Bounded maintenance, independent of whether a future snapshot fits its cap.
 * Call in its own transaction; issuance also does one conservative batch. */
export async function pruneEndpointTelemetryContexts(tx: Transaction): Promise<number> {
  await advisoryTransactionLock(tx, storageLock);
  return pruneUnlocked(tx);
}

async function pruneUnlocked(tx: Transaction): Promise<number> {
  await tx.execute(sql`insert into endpoint_telemetry_context_gc_cursor(id) values ('singleton') on conflict do nothing`);
  // The persisted sweep cursor bounds *visited* rows, not only deleted rows.
  // Protected older history cannot starve later unreferenced cleanup forever.
  const candidates = await tx.execute<{ id: string; retired_at: string }>(sql`
    select c.id, c.retired_at::text as retired_at from endpoint_telemetry_context c,
      endpoint_telemetry_context_gc_cursor gc,
      (select clock_timestamp() - interval '31 days' as before) cutoff
    where gc.id = 'singleton' and c.retired_at < cutoff.before
      and (gc.last_retired_at is null or (c.retired_at,c.id) > (gc.last_retired_at,gc.last_context_id))
    order by c.retired_at,c.id limit ${endpointContextCleanupBatchSize}`);
  const last = candidates.rows.at(-1);
  await tx.execute(last
    ? sql`update endpoint_telemetry_context_gc_cursor set last_retired_at = ${last.retired_at}::timestamptz,
        last_context_id = ${last.id} where id = 'singleton'`
    : sql`update endpoint_telemetry_context_gc_cursor set last_retired_at = null,last_context_id = null where id = 'singleton'`);
  if (!last) return 0;
  const result = await tx.delete(contexts).where(and(inArray(contexts.id, candidates.rows.map(row => row.id)),
    sql`not exists (select 1 from runtime_event e where e.allocation_context_id = ${contexts.id})`,
    sql`not exists (select 1 from model_usage_cost u where u.allocation_context_id = ${contexts.id})`,
    sql`not exists (select 1 from route_assignment a where a.allocation_context_id = ${contexts.id})`)).returning({ id: contexts.id });
  return result.length;
}
