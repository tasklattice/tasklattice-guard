// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, sql } from "drizzle-orm";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { runtimeLogPageSource } from "./runtime-log-source.js";
import { runWithProjectContext } from "./project-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("request-growth query plans (PostgreSQL)", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "telemetry_plans");
    await database.db.execute(sql`INSERT INTO route_assignment(project_id,decision_id,call_id,occurred_at,endpoint_id,router_id,router_revision,route_id,target_id,guardrail_id,guardrail_version,assignment_status,completed_at,outcome,duration_ms)
      SELECT 'projectA','decision-'||n,'call-'||n,now()-n*interval '1 second','endpoint','router',1,'route','target','guard','v1','assigned',now(),
        CASE WHEN n%1000=0 THEN 'error' ELSE 'allow' END,10 FROM generate_series(1,100000) n`);
    await database.db.execute(sql`INSERT INTO runtime_event(id,project_id,occurred_at,request_id,runner_id,guardrail_id,endpoint_id,direction,decision,duration_ms,metadata)
      SELECT 'event-'||n,'projectA',now()-n*interval '1 second','call-'||n,'runner','guard','endpoint','incoming','block',10,
        CASE WHEN n%1000=0 THEN '{"executionStatus":"error"}'::jsonb ELSE '{}'::jsonb END FROM generate_series(1,10000) n`);
    await database.pool.query("VACUUM ANALYZE route_assignment");
    await database.pool.query("VACUUM ANALYZE runtime_event");
  }, 30_000);
  afterAll(async () => { await database?.drop(); });

  it.each([null, "projectA"])("uses the failure feed index even without a router filter (project=%s)", async projectId => {
    const query = await runWithProjectContext(projectId ? { projectId, role: "user" } : { projectId: null, role: "admin" }, async () => {
      const logs = runtimeLogPageSource(database.db, undefined, 51);
      return database.db.select({ id: logs.id, occurredAt: logs.occurredAt }).from(logs)
        .orderBy(desc(logs.occurredAt), desc(logs.id)).limit(51).toSQL();
    });
    const result = await database.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${query.sql}`, query.params);
    const serialized = JSON.stringify(result.rows);
    expect(serialized).toContain(projectId ? "route_assignment_project_failure_time_id_idx" : "route_assignment_failure_time_id_idx");
    const plan = result.rows[0]["QUERY PLAN"][0].Plan;
    const nodes = (node: any): any[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
    const scans = nodes(plan).filter(node => node["Relation Name"] === "route_assignment");
    expect(scans).toHaveLength(1);
    expect(scans[0]["Actual Rows"]).toBeLessThanOrEqual(51);
    expect(scans[0]["Node Type"]).not.toBe("Seq Scan");
  });

  it("finds execution errors through the matching partial index even when decisions are blocks", async () => {
    const result = await database.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT occurred_at FROM runtime_event WHERE endpoint_id='endpoint'
      AND COALESCE(metadata->>'executionStatus' IN ('error','timeout'),false)
      ORDER BY occurred_at DESC LIMIT 1`);
    expect(JSON.stringify(result.rows)).toContain("runtime_event_endpoint_error_time_idx");
    const row = await database.pool.query(`SELECT id FROM runtime_event WHERE endpoint_id='endpoint'
      AND COALESCE(metadata->>'executionStatus' IN ('error','timeout'),false) ORDER BY occurred_at DESC LIMIT 1`);
    expect(row.rows[0].id).toBe("event-1000");
  });
});
