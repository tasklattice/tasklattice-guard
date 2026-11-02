// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { runtimeEvents } from "../db/schema.js";
import type { RuntimeEventInput } from "../domain/models.js";
import { writeRuntimeEvent } from "./runtime-event-write.js";

describe.skipIf(!process.env.GUARD_TEST_POSTGRES_URL)("correlated runtime body enrichment (PostgreSQL)", () => {
  const pool = new Pool({ connectionString: process.env.GUARD_TEST_POSTGRES_URL, max: 1 });
  const db = drizzle(pool);
  beforeAll(async () => {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.GUARD_TEST_POSTGRES_URL!).hostname)) throw new Error("Loopback database required");
    await db.execute(sql`CREATE TEMP TABLE runtime_event (
      id text PRIMARY KEY, occurred_at timestamptz NOT NULL, received_at timestamptz DEFAULT now(),
      request_id text NOT NULL, runner_id text NOT NULL, guardrail_id text, guardrail_version text,
      endpoint_id text, router_id text, direction text, decision text, duration_ms integer,
      metadata jsonb NOT NULL DEFAULT '{}')`);
  });
  afterAll(async () => { await pool.end(); });
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
    expect(rows[0]).toMatchObject({ requestId: "call", runnerId: "input-runner", occurredAt: base.occurredAt, durationMs: 4, metadata: enriched.metadata });
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
