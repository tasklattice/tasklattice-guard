// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { queryRuntimeMetrics } from "./runtime-metrics.js";
import { runWithProjectContext } from "./project-context.js";
import { runtimeEvents } from "../db/schema.js";
import { writeRuntimeEvents } from "./runtime-event-write.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("transactional runtime overview (PostgreSQL)", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const now = Date.parse("2026-11-11T11:23:45Z");
  const read = (guardrailId: string, projectId = "projectA", window: "1h" | "24h" | "7d" | "15d" | "30d" = "24h") =>
    runWithProjectContext({ projectId, role: "user" }, () => queryRuntimeMetrics(database.db, { guardrailId, window, view: "overview" }));
  beforeAll(async () => {
    database = await createTestDatabase(url!, "overview");
    vi.spyOn(Date, "now").mockReturnValue(now);
  });
  afterAll(async () => { vi.restoreAllMocks(); await database?.drop(); });

  it("keeps exact totals and bounded buckets as request count grows", async () => {
    const insert = (from: number, until: number) => database.db.execute(sql`
      INSERT INTO runtime_event(id,project_id,occurred_at,request_id,runner_id,guardrail_id,endpoint_id,direction,decision,duration_ms,metadata)
      SELECT 'scale-'||n,'projectA','2026-11-11T11:00:00Z','request-'||n,'runner','scale','endpoint','incoming',
        CASE WHEN n%2=0 THEN 'block' ELSE 'allow' END,100,
        '{"captureLevel":"trace","trace":[{"kind":"action","durationMs":100}],"contentBefore":"private-body"}'::jsonb
      FROM generate_series(${from}::int,${until}::int) n`);
    await insert(1, 1000);
    const size = async () => (await database.db.execute<{ count: string }>(sql`SELECT count(*) FROM runtime_overview_bucket WHERE guardrail_id='scale'`)).rows[0]!.count;
    const before = await size();
    await insert(1001, 50_000);
    expect(await size()).toBe(before);
    expect(Number(before)).toBe(3);
    for (const window of ["1h", "24h", "7d", "15d", "30d"] as const) {
      const result = await read("scale", "projectA", window);
      expect(result.total_decisions).toBe(50_000);
      expect(result.allowed).toBe(25_000);
      expect(result.blocked).toBe(25_000);
      expect(result.trend.reduce((sum, point) => sum + point.total, 0)).toBe(50_000);
      expect(result.runtime_p95_ms).toBeGreaterThanOrEqual(100);
      expect(result.runtime_p95_ms).toBeLessThanOrEqual(106);
      expect(result.latency_method).toBe("histogram_5pct");
      expect(result.view).toBe("overview");
      expect(JSON.stringify(result)).not.toContain("private-body");
      expect(result.action_metrics).toEqual([]);
    }
  }, 30_000);

  it("covers coarse bucket boundaries and comparison periods without gaps or double counts", async () => {
    const end = Date.parse("2026-11-11T11:24:00Z"), start = end - 7 * 86400_000;
    const timestamps = [start-7*86400_000-1, start-7*86400_000, start-1, start, start+1,
      start+36*60_000, end-24*60_000, end-1, end];
    for (const [index, at] of timestamps.entries()) await database.db.execute(sql`
      INSERT INTO runtime_event(id,project_id,occurred_at,request_id,runner_id,guardrail_id,direction,decision,duration_ms)
      VALUES (${`edge-${index}`},'projectA',${new Date(at).toISOString()}::timestamptz,${`edge-${index}`},'runner','edges','incoming','allow',2500)`);
    const result = await read("edges", "projectA", "7d");
    expect(result.total_decisions).toBe(5);
    expect(result.comparison.previous_total_decisions).toBe(2);
    expect(result.trend.reduce((n, point) => n + point.total, 0)).toBe(5);
    expect(result.window_start).toBe(new Date(start).toISOString());
    expect(result.window_end).toBe(new Date(end).toISOString());
    expect(result.runtime_p95_ms).toBe(2500);
    expect(result.latency_slo.p95_status).toBe("healthy");
  });

  it("isolates tenants and router filters and counts distinct degraded endpoints across buckets", async () => {
    await database.db.execute(sql`INSERT INTO runtime_event(id,project_id,occurred_at,request_id,runner_id,guardrail_id,router_id,endpoint_id,direction,decision,duration_ms,metadata)
      VALUES ('scope-a','projectA','2026-11-11T10:00:00Z','scope-a','runner','scope','router-a','shared','incoming','block',4,'{"executionStatus":"timeout","usage":{"fail_closed":true}}'),
        ('scope-a2','projectA','2026-11-11T11:00:00Z','scope-a2','runner','scope','router-b','shared','outgoing','allow',5,'{"executionStatus":"error"}'),
        ('scope-b','projectB','2026-11-11T11:00:00Z','scope-b','runner','scope','router-a','shared','incoming','allow',3,'{}')`);
    const a = await read("scope"), b = await read("scope", "projectB");
    expect(a).toMatchObject({ total_decisions: 2, errors: 2, blocked: 0, timeout_count: 1, fail_closed_count: 1, degraded_endpoints: 1 });
    expect(b).toMatchObject({ total_decisions: 1, errors: 0, allowed: 1 });
    const router = await runWithProjectContext({ projectId: "projectA", role: "user" }, () => queryRuntimeMetrics(database.db,
      { window: "24h", guardrailId: "scope", routerId: "router-b", view: "overview" }));
    expect(router.total_decisions).toBe(1);
  });

  it("applies late arrivals, correction, deletion and rollback atomically", async () => {
    await database.db.execute(sql`INSERT INTO runtime_event(id,project_id,occurred_at,request_id,runner_id,guardrail_id,direction,decision,duration_ms)
      VALUES ('corrected','projectA','2026-11-10T12:00:00Z','corrected','runner','correction','incoming','allow',10)`);
    expect((await read("correction")).total_decisions).toBe(1);
    await database.db.execute(sql`UPDATE runtime_event SET duration_ms=5000,metadata='{"executionStatus":"error"}' WHERE id='corrected'`);
    expect(await read("correction")).toMatchObject({ total_decisions: 1, errors: 1, allowed: 0, runtime_p95_ms: 5000 });
    await expect(database.db.transaction(async tx => {
      await tx.execute(sql`DELETE FROM runtime_event WHERE id='corrected'`);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect((await read("correction")).total_decisions).toBe(1);
    await database.db.execute(sql`DELETE FROM runtime_event WHERE id='corrected'`);
    expect((await read("correction")).total_decisions).toBe(0);
  });

  it("does not count retries or body enrichment twice, including batched ingestion", async () => {
    const event = { id: "retry", occurredAt: new Date("2026-11-11T11:00:00Z"), requestId: "retry", runnerId: "runner",
      guardrailId: "retry", direction: "incoming" as const, decision: "allow" as const, durationMs: 30, metadata: { captureLevel: "info" } };
    // Direct trusted imports without correlation are intentionally quarantined
    // to the platform scope; use the same behavior as the production writer.
    await writeRuntimeEvents(database.db, [event, event]);
    const readPlatform = () => queryRuntimeMetrics(database.db, { window: "24h", guardrailId: "retry", view: "overview" });
    const before = await readPlatform();
    expect(before.total_decisions).toBe(1);
    await writeRuntimeEvents(database.db, [event, { ...event, metadata: { runtimeLogCaptured: true, contentCiphertext: "encrypted" } }]);
    expect(await readPlatform()).toMatchObject({ total_decisions: 1, runtime_p95_ms: before.runtime_p95_ms });
    const rows = await database.db.select().from(runtimeEvents).where(sql`id='retry'`);
    expect(rows[0]!.metadata.contentCiphertext).toBe("encrypted");
  });

  it("bounds percentile error for a varied latency distribution", async () => {
    await database.db.execute(sql`INSERT INTO runtime_event(id,project_id,occurred_at,request_id,runner_id,guardrail_id,direction,decision,duration_ms)
      SELECT 'latency-'||n,'projectA','2026-11-11T11:00:00Z','latency-'||n,'runner','latency','incoming','allow',n
      FROM generate_series(1,10000) n`);
    const result = await read("latency");
    for (const [actual, exact] of [[result.runtime_p50_ms,5000],[result.runtime_p95_ms,9500],[result.runtime_p99_ms,9900]]) {
      expect(actual).toBeGreaterThanOrEqual(exact!);
      expect(actual).toBeLessThanOrEqual(exact! * 1.05 + 1);
    }
    expect(result.total_decisions).toBe(10000);
  });

  it("merges concurrent batches without lost increments", async () => {
    await Promise.all(["one", "two"].map(prefix => database.db.execute(sql`
      INSERT INTO runtime_event(id,project_id,occurred_at,request_id,runner_id,guardrail_id,direction,decision,duration_ms)
      SELECT ${prefix}||n,'projectA','2026-11-11T11:00:00Z',${prefix}||n,'runner','concurrent','incoming','allow',n
      FROM generate_series(1,100) n`)));
    expect((await read("concurrent")).total_decisions).toBe(200);
  });

  it("backfills existing history with the same projection as live writes", async () => {
    const before = await read("scale");
    await database.db.execute(sql`TRUNCATE runtime_overview_bucket`);
    await database.db.execute(sql`DO $rebuild$ BEGIN
      EXECUTE runtime_overview_sql('SELECT *,1::bigint AS weight FROM runtime_event');
    END $rebuild$`);
    expect(await read("scale")).toEqual(before);
    expect((await read("concurrent")).total_decisions).toBe(200);
  });
});
