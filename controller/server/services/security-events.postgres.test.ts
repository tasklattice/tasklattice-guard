// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { securityEventsQuery } from "../../shared/security-events.js";
import { querySecurityEvents } from "./security-events.js";
import type { ControllerDatabase } from "../db/client.js";

// Session-local temporary table only; application records are never modified.
describe.skipIf(!process.env.TEST_DATABASE_URL)("Security Event item pagination (PostgreSQL)", () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  const db = drizzle(pool) as ControllerDatabase;
  const until = "2026-10-15T08:00:00.000Z";
  const query = (overrides: Record<string, unknown> = {}) => querySecurityEvents(db, securityEventsQuery.parse({ guardrailId: "pagination", until, ...overrides }));
  beforeAll(async () => {
    await db.execute(sql`CREATE TEMP TABLE runtime_event (LIKE public.runtime_event INCLUDING DEFAULTS)`);
    await db.execute(sql`INSERT INTO runtime_event(id,occurred_at,received_at,request_id,runner_id,guardrail_id,direction,decision,duration_ms,metadata)
      SELECT 'checkpoint-'||n, '2026-10-15T07:59:59.123456Z', '2026-10-15T07:59:59Z', 'call-'||n, 'runner', 'pagination', 'incoming', 'block', 1,
        jsonb_build_object('contentCiphertext','private content','trace',repeat('private trace',1000),'findings',
          (SELECT jsonb_agg(jsonb_build_object('id','repeated-local-id','verdict','matched','riskSeverity',CASE WHEN i%2=0 THEN 'high' ELSE 'critical' END,'ruleId','rule-'||i,'evidence',repeat('private evidence',1000))) FROM generate_series(1,63) i))
      FROM generate_series(1,2) n`);
    await db.execute(sql`INSERT INTO runtime_event(id,occurred_at,received_at,request_id,runner_id,guardrail_id,direction,decision,duration_ms,metadata)
      VALUES ('old','2026-10-13T07:00:00Z','2026-10-13T07:00:00Z','old','runner','pagination','incoming','block',1,'{"findings":[{"verdict":"matched"}]}'),
      ('other','2026-10-15T07:00:00Z','2026-10-15T07:00:00Z','other','runner','other','incoming','block',1,'{"findings":[{"verdict":"matched"}]}'),
      ('late','2026-10-15T07:00:00Z','2026-10-15T08:00:01Z','late','runner','pagination','incoming','block',1,'{"findings":[{"verdict":"matched"}]}'),
      ('future','2026-10-15T08:00:01Z','2026-10-15T07:00:00Z','future','runner','pagination','incoming','block',1,'{"findings":[{"verdict":"matched"}]}')`);
  });
  afterAll(async () => { await pool.end(); });

  it.each([25, 50])("limits each page to %i findings, including inside a single checkpoint", async limit => {
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await query({ limit, cursor });
      expect(page.count).toBe(page.items.length);
      expect(page.count).toBeLessThanOrEqual(limit);
      expect(page.until).toBe(until);
      expect(JSON.stringify(page)).not.toContain("private");
      for (const event of page.items) {
        const id = `${event.eventId}:${event.findingIndex}`;
        expect(ids.has(id)).toBe(false);
        ids.add(id);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids.size).toBe(126);
    expect(ids.has("checkpoint-2:63")).toBe(true);
    expect(ids.has("checkpoint-1:1")).toBe(true);
  });

  it("applies risk filters before the item limit and keeps unknown verdicts and historical severity", async () => {
    await db.execute(sql`INSERT INTO runtime_event(id,occurred_at,received_at,request_id,runner_id,guardrail_id,direction,decision,duration_ms,metadata)
      VALUES ('missing-severity','2026-10-15T07:00:00Z','2026-10-15T07:00:00Z','missing-severity','runner','classification','incoming','allow',1,
        '{"findings":[{"verdict":"unknown"},{"verdict":"error","riskSeverity":"critical"},{"verdict":"not_matched","riskSeverity":"critical"}]}')`);
    const filtered = await query({ severity: "high" });
    expect(filtered.count).toBe(25);
    expect(filtered.items.every(item => item.finding.riskSeverity === "high")).toBe(true);
    const unclassified = await query({ guardrailId: "classification", severity: "unclassified" });
    expect(unclassified.items.map(item => item.finding.verdict)).toEqual(["unknown"]);
    expect(unclassified.nextCursor).toBeNull();
  });

  it("rejects invalid or reused cursors and holds the original range without an explicit until", async () => {
    const first = await query();
    const second = await query({ cursor: first.nextCursor, until: undefined });
    expect(second.until).toBe(until);
    for (const change of [{ cursor: "invalid" }, { limit: 50 }, { severity: "high" }, { guardrailId: "other" }, { window: "7d" }, { until: "2026-10-15T09:00:00.000Z" }]) {
      await expect(query({ cursor: first.nextCursor, ...change })).rejects.toThrow("Invalid Security Event cursor");
    }
    expect((await query({ guardrailId: "empty" })).items).toEqual([]);
  });
});
