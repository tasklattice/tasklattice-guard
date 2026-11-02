// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { validationRuns } from "../db/schema.js";
import { queryTestingReports, validationDetailColumns } from "./testing-reports.js";
import { runWithTenantContext } from "./tenant-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Bounded testing report reads", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "report_reads");
    await database.pool.query(`INSERT INTO guardrail (id, name, draft_config) VALUES ('guard', 'Report search fixture', '{}')`);
    await database.pool.query(`INSERT INTO guardrail_validation_run
      (id, guardrail_id, guardrail_version, source_draft_revision, subject, status, results, candidate_artifact, candidate_policies, created_at)
      SELECT 'run-' || lpad(n::text, 2, '0'), 'guard', 'v1', 1, 'version',
        CASE WHEN n = 30 THEN 'running' WHEN n = 29 THEN 'failed' ELSE 'passed' END,
        jsonb_build_array(jsonb_build_object('outputContent', repeat('x', 100000))), '{"large":"artifact"}', '[{"large":"policy"}]',
        '2026-01-01T00:00:00.123456Z'::timestamptz FROM generate_series(1, 30) n`);
    await database.pool.query(`INSERT INTO guardrail_version (guardrail_id, version, generation, status, runtime_profile, plan, validation_run_id, released_at)
      VALUES ('guard', 'v1', 1, 'ready', 'auto', '{}', 'run-01', now())`);
  });
  afterAll(async () => { await database?.drop(); });

  it("pages tied timestamps without materializing result bodies and retains version evidence", async () => {
    const first = await queryTestingReports(database.db, { guardrailId: "guard" });
    expect(first.items).toHaveLength(25);
    expect(first.count).toBe(30);
    expect(JSON.stringify(first).length).toBeLessThan(30000);
    for (const item of [...first.items, ...first.versionReports]) {
      for (const column of ["results", "candidateArtifact", "candidatePolicies", "candidateInspection", "testSuite"])
        expect(item).not.toHaveProperty(column);
    }
    expect(first.versionReports.map(item => item.id).sort()).toEqual(["run-01", "run-29", "run-30"]);
    const second = await queryTestingReports(database.db, { guardrailId: "guard", cursor: first.nextCursor! });
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(30);
    expect(second.versionReports).toEqual(first.versionReports);
    const [detail] = await database.db.select(validationDetailColumns).from(validationRuns).where(eq(validationRuns.id, "run-01"));
    expect(detail!.results[0]).toMatchObject({ outputContent: "x".repeat(100000) });
  });

  it("applies search and status before pagination and rejects invalid limits/cursors", async () => {
    const failed = await queryTestingReports(database.db, { q: "search fixture", status: "failed", limit: 1 });
    expect(failed.items.map(item => item.id)).toEqual(["run-29"]);
    expect(failed.count).toBe(1);
    expect((await queryTestingReports(database.db, { status: "incomplete" })).items.map(item => item.id)).toEqual(["run-30"]);
    expect((await queryTestingReports(database.db, { q: "run-01" })).count).toBe(1);
    await expect(queryTestingReports(database.db, { limit: 10000 })).rejects.toThrow();
    await expect(queryTestingReports(database.db, { cursor: "invalid" })).rejects.toThrow("cursor");
  });

  it("does not disclose version evidence for a guessed Guardrail ID without an active share", async () => {
    await database.pool.query("INSERT INTO tenant_group(id,name) VALUES ('group-c','Group C'); UPDATE tenant SET group_id='group-c' WHERE id='tenantC'");
    const asTenant = <T>(tenantId: string, work: () => T) => runWithTenantContext({ tenantId }, work);
    const reports = (tenantId: string) => asTenant(tenantId, () => queryTestingReports(database.db, { guardrailId: "guard" }));
    expect((await reports("tenantA")).versionReports.map(item => item.id).sort()).toEqual(["run-01", "run-29", "run-30"]);
    for (const tenant of ["tenantB", "tenantC"]) {
      expect(await reports(tenant)).toMatchObject({ items: [], count: 0, versionReports: [] });
    }
    await database.pool.query(`INSERT INTO resource_share(id,owner_tenant_id,recipient_tenant_id,resource_type,resource_id)
      VALUES ('guard-share','tenantA','tenantB','guardrail','guard')`);
    expect((await reports("tenantB")).versionReports.map(item => item.id).sort()).toEqual(["run-01", "run-29", "run-30"]);
    expect(await reports("tenantC")).toMatchObject({ items: [], count: 0, versionReports: [] });
    await database.pool.query("DELETE FROM resource_share WHERE id='guard-share'");
    expect(await reports("tenantB")).toMatchObject({ items: [], count: 0, versionReports: [] });
  }, 30000);
});
