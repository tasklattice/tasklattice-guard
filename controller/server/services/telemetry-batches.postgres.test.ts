// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { ControlPlaneService } from "./control-plane.js";
import type { ControllerConfig } from "../config.js";
import type { RuntimeEventInput } from "../domain/models.js";
import { telemetryBatches } from "./telemetry-batches.js";
import { sql } from "drizzle-orm";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("bounded telemetry transactions and replay", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "telemetry_chunks");
    database.pool.options.max = 1;
    await database.pool.query("INSERT INTO guardrail(id,name,draft_config) VALUES ('guard','Guard','{}')");
  });
  afterAll(async () => { await database?.drop(); });

  it("commits prefixes, gives a queued reader the connection, rolls back a failed chunk and replays costs exactly once", async () => {
    const service = new ControlPlaneService(database.db, {} as ControllerConfig);
    const events: RuntimeEventInput[] = Array.from({ length: 120 }, (_, i) => ({
      id: `batch-${i}`, requestId: `request-${i}`, runnerId: "runner", guardrailId: "guard",
      occurredAt: new Date(Date.now() - (120 - i) * 1000), direction: "incoming", decision: "allow", durationMs: 1,
      metadata: { usage: { model_calls: [{ call_id: `call-${i}`, provider: "synthetic", model: "synthetic", usage_known: true, input_tokens: 1, output_tokens: 1 }] } },
    }));
    await database.pool.query(`CREATE FUNCTION reject_batch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = 'batch-60' THEN RAISE EXCEPTION 'injected chunk failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$`);
    await database.pool.query("CREATE TRIGGER reject_batch BEFORE INSERT ON runtime_event FOR EACH ROW EXECUTE FUNCTION reject_batch()");
    let interleaved: Promise<{ rows: Array<{ n: number }> }> | undefined;
    database.pool.once("release", () => { interleaved = database.pool.query("SELECT count(*)::int AS n FROM runtime_event"); });
    await expect(service.recordRuntimeEvents(events)).rejects.toMatchObject({ cause: { code: "23514" } });
    const firstCount = (await interleaved!)!.rows[0]!.n;
    expect(firstCount).toBeGreaterThan(0);
    expect(firstCount).toBeLessThanOrEqual(50);
    const committed = (await database.pool.query("SELECT count(*)::int AS n FROM runtime_event")).rows[0].n;
    expect(committed).toBeGreaterThan(0); expect(committed).toBeLessThanOrEqual(60);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM model_usage_cost")).rows[0].n).toBe(committed);
    await database.pool.query("DROP TRIGGER reject_batch ON runtime_event");
    await service.recordRuntimeEvents(events);
    await service.recordRuntimeEvents([...events].reverse());
    expect((await database.pool.query("SELECT count(*)::int AS n FROM runtime_event")).rows[0].n).toBe(120);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM model_usage_cost")).rows[0].n).toBe(120);
    expect((await database.pool.query("SELECT last_event_occurred_at FROM telemetry_watermark WHERE runner_id='runner'")).rows[0].last_event_occurred_at).toEqual(events[119]!.occurredAt);
    expect(database.pool.idleCount).toBe(1); expect(database.pool.waitingCount).toBe(0);
  });

  it("ends a slow chunk at the time budget while keeping each event atomic", async () => {
    const transactionIds: unknown[] = [];
    await telemetryBatches(database.db, [1, 2, 3], async tx => ({ write: async () => {
      transactionIds.push((await tx.execute(sql`SELECT txid_current() AS id, pg_sleep(0.6)`)).rows[0]!.id);
    } }));
    expect(transactionIds[0]).toBe(transactionIds[1]);
    expect(transactionIds[2]).not.toBe(transactionIds[1]);
    expect(database.pool.idleCount).toBe(1);
  });
});
