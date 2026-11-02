// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { queryAuditEvents } from "./audit-events.js";

// Session-local temporary table: never changes application records.
describe.skipIf(!process.env.GUARD_TEST_POSTGRES_URL)("audit queries (PostgreSQL)", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];
  const before = "2026-09-29T00:00:00.000Z";
  beforeAll(async () => {
    database = await createTestDatabase(process.env.GUARD_TEST_POSTGRES_URL!, "audit_queries", { maxConnections: 1 });
    db = database.db;
    await db.execute(sql`CREATE TEMP TABLE audit_event (LIKE ${sql.identifier(database.schema)}.audit_event INCLUDING DEFAULTS)`);
    await db.execute(sql`INSERT INTO audit_event(id,kind,actor_id,resource_type,resource_id,detail,occurred_at)
      SELECT 'audit-'||lpad(n::text,5,'0'),'guardrail.updated',CASE WHEN n%2=1 THEN 'human' ELSE NULL END,'guardrail','guard-'||n,'{}'::jsonb,${before}::timestamptz - interval '1 hour' FROM generate_series(1,1001) n`);
    await db.execute(sql`UPDATE audit_event SET occurred_at=${before}::timestamptz - interval '20 days',kind='policy.updated',resource_type='policy',detail='{"name":"Older needle %_ case"}'::jsonb WHERE id='audit-00001'`);
    await db.execute(sql`INSERT INTO audit_event(id,kind,resource_type,resource_id,occurred_at) VALUES ('outside','runner.connected','runner','runner',${before}::timestamptz - interval '40 days')`);
  });
  afterAll(async () => { await database?.drop(); });
  it("searches older records beyond the latest 500 and counts the complete filtered result", async () => {
    const found = await queryAuditEvents(db, { q: "NEEDLE", window: "30d", before, limit: 1 });
    expect(found.total).toBe(1);
    expect(found.items.map(row => row.id)).toEqual(["audit-00001"]);
    expect((await queryAuditEvents(db, { window: "all", before })).total).toBe(1002);
    expect((await queryAuditEvents(db, { window: "7d", before })).total).toBe(1000);
  });
  it("applies combined filters before paging; facets describe the chosen time range", async () => {
    const result = await queryAuditEvents(db, { actor: "human", kind: "policy.updated", resourceType: "policy", window: "30d", before });
    expect(result.total).toBe(1);
    expect(result.items[0]?.actorId).toBe("human");
    expect(result.facets.resourceTypes).toEqual(["guardrail", "policy"]);
    expect((await queryAuditEvents(db, { actor: "system", kind: "policy.updated", window: "all", before })).total).toBe(0);
  });
  it("pages equal timestamps without duplication and excludes events newer than the anchor", async () => {
    const ids: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const result = await queryAuditEvents(db, { window: "all", before, limit: 500, page });
      ids.push(...result.items.map(row => row.id));
    }
    expect(ids).toHaveLength(1002);
    expect(new Set(ids).size).toBe(1002);
    await db.execute(sql`INSERT INTO audit_event(id,kind,resource_type,resource_id,occurred_at) VALUES ('new','runner.connected','runner','runner',${before}::timestamptz + interval '1 second')`);
    try {
      expect((await queryAuditEvents(db, { window: "all", before })).total).toBe(1002);
      expect((await queryAuditEvents(db, { window: "all", before: "2026-09-29T00:00:02.000Z" })).total).toBe(1003);
    } finally { await db.execute(sql`DELETE FROM audit_event WHERE id='new'`); }
  });
  it("treats SQL wildcard characters literally and safely clamps out-of-range pages", async () => {
    expect((await queryAuditEvents(db, { q: "%_", window: "all", before })).total).toBe(1);
    expect((await queryAuditEvents(db, { q: "' OR 1=1 --", window: "all", before })).total).toBe(0);
    const page = await queryAuditEvents(db, { window: "all", before, page: 999, limit: 100 });
    expect(page.page).toBe(11);
    expect(page.items).toHaveLength(2);
  });
});
