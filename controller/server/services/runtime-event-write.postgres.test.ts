// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { runtimeEvents } from "../db/schema.js";
import type { RuntimeEventInput } from "../domain/models.js";
import { writeRuntimeEvent } from "./runtime-event-write.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("correlated runtime body enrichment (PostgreSQL)", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let db: ControllerDatabase;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "runtime_enrichment");
    db = database.db;
    await database.pool.query("INSERT INTO guardrail (id,tenant_id,name,draft_config) VALUES ('guard','tenantA','Shared definition','{}')");
    await database.pool.query("INSERT INTO endpoint (id,tenant_id,name,adapter) VALUES ('endpoint','tenantB','Caller Endpoint','litellm-generic-guardrail')");
  }, 30_000);
  afterAll(async () => { await database?.drop(); });
  function event(id: string): RuntimeEventInput {
    return { id, occurredAt: new Date("2026-10-14T01:00:00Z"), requestId: "call", runnerId: "input-runner",
      guardrailId: "guard", endpointId: "endpoint", direction: "incoming", decision: "allow", durationMs: 4,
      metadata: { runtimeLogCaptured: false, captureLevel: "debug", trace: [{ id: "step" }], findings: [] } };
  }
  const captured = (base: RuntimeEventInput): RuntimeEventInput => ({ ...base,
    metadata: { ...base.metadata, runtimeLogCaptured: true, contentCaptureStatus: "captured", contentCiphertext: "encrypted-original" } });

  it.each([false, true])("keeps one complete event when enrichment arrives first=%s", async enrichmentFirst => {
    const base = event(`order-${enrichmentFirst}`), enriched = captured(base);
    for (const input of enrichmentFirst ? [enriched, base, enriched, base] : [base, enriched, enriched, base]) await writeRuntimeEvent(db, input);
    const rows = await db.select().from(runtimeEvents).where(eq(runtimeEvents.id, base.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: "tenantB", requestId: "call", runnerId: "input-runner", occurredAt: base.occurredAt, durationMs: 4, metadata: enriched.metadata });
  });

  it("enriches only content fields and never overwrites captured originals", async () => {
    const base = event("immutable");
    await writeRuntimeEvent(db, base);
    await writeRuntimeEvent(db, { ...captured(base), decision: "block", durationMs: 999,
      metadata: { ...captured(base).metadata, trace: [], findings: [{ risk: "other" }] } });
    await writeRuntimeEvent(db, { ...captured(base), metadata: { ...captured(base).metadata, contentCiphertext: "replacement" } });
    const [row] = await db.select().from(runtimeEvents).where(eq(runtimeEvents.id, base.id));
    expect(row).toMatchObject({ decision: "allow", durationMs: 4, metadata: { ...base.metadata,
      runtimeLogCaptured: true, contentCaptureStatus: "captured", contentCiphertext: "encrypted-original" } });
  });

  it.each(["requestId", "runnerId", "endpointId", "guardrailId"] as const)("rejects enrichment from another %s", async field => {
    const base = event(`scope-${field}`);
    await writeRuntimeEvent(db, base);
    await writeRuntimeEvent(db, { ...captured(base), [field]: "unrelated" });
    const [row] = await db.select().from(runtimeEvents).where(eq(runtimeEvents.id, base.id));
    expect(row!.metadata).toEqual(base.metadata);
  });
});
