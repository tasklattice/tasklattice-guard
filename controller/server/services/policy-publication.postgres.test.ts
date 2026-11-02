// @vitest-environment node
// Real transactions in an isolated schema on the explicitly selected local DB.
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ControllerConfig } from "../config.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { programmablePolicyDraftSchema } from "../policy-studio/model.js";
import { ControlPlaneService } from "./control-plane.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Policy publication identity in PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool; let service: ControlPlaneService;
  const draft = programmablePolicyDraftSchema.parse({ guardrail_category: "content_safety", sources: [{ path: "main.co", content: "flow check $text\n  pass\n" }],
    rail_bindings: [{ rail_type: "input", flow_name: "check", execution_mode: "detect", on_unsafe: "block", risk_severity: "medium" }],
    test_cases: [{ name: "safe", rail_type: "input", content: "ordinary", expected_decision: "allow", covered_rule_ids: ["flow/input/check"], case_type: "input_rail" }] });
  beforeAll(async () => {
    database = await createTestDatabase(url!, "guard_policy_publish", { maxConnections: 4 });
    pool = database.pool;
    await pool.query("INSERT INTO auth_user (id,name,email,role) VALUES ('test','Test','policy-test@example.test','admin')");
    service = new ControlPlaneService(database.db, {} as ControllerConfig);
  });
  afterAll(async () => {
    await database?.drop();
  });
  beforeEach(async () => {
    for (const table of ["policy_version", "policy_record", "policy_validation_run", "audit_event"]) await pool.query(`DELETE FROM "${table}"`);
    await pool.query("INSERT INTO policy_record (id,name,owner,draft) VALUES ('fixture','Publication identity','test',$1)", [draft]);
    await pool.query("INSERT INTO policy_validation_run (id,policy_id,draft_revision,status,created_by) VALUES ('run-1','fixture',1,'passed','test')");
  });
  it("returns one exact version and one audit event for concurrent retries", async () => {
    const versions = await Promise.all(Array.from({ length: 8 }, () => service.publishPolicy({ id: "fixture", actorId: "test", expectedDraftRevision: 1 })));
    for (const version of versions) expect(version).toEqual(versions[0]);
    expect((await pool.query("SELECT count(*)::int AS count FROM policy_version")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_event")).rows[0].count).toBe(1);
  });
  it("recovers a committed response even after a later unvalidated draft edit", async () => {
    const committed = await service.publishPolicy({ id: "fixture", actorId: "test", expectedDraftRevision: 1 });
    await pool.query("UPDATE policy_record SET draft_revision=2,name='Later edit' WHERE id='fixture'");
    expect(await service.publishPolicy({ id: "fixture", actorId: "test", expectedDraftRevision: 1 })).toEqual(committed);
    await expect(service.publishPolicy({ id: "fixture", actorId: "test", expectedDraftRevision: 2 })).rejects.toThrow("must pass validation");
  });
  it("rejects an unpublished stale revision rather than publishing the newer draft", async () => {
    await pool.query("UPDATE policy_record SET draft_revision=2 WHERE id='fixture'");
    await pool.query("UPDATE policy_validation_run SET draft_revision=2 WHERE policy_id='fixture'");
    await expect(service.publishPolicy({ id: "fixture", actorId: "test", expectedDraftRevision: 1 })).rejects.toThrow("draft changed");
    expect((await pool.query("SELECT count(*)::int AS count FROM policy_version")).rows[0].count).toBe(0);
  });
  it("creates the next version only for a newly validated revision", async () => {
    const first = await service.publishPolicy({ id: "fixture", actorId: "test", expectedDraftRevision: 1 });
    await pool.query("UPDATE policy_record SET draft_revision=2 WHERE id='fixture'");
    await pool.query("UPDATE policy_validation_run SET draft_revision=2 WHERE policy_id='fixture'");
    const second = await service.publishPolicy({ id: "fixture", actorId: "test", expectedDraftRevision: 2 });
    expect(first.version).toBe("1"); expect(second.version).toBe("2");
    expect(await service.publishPolicy({ id: "fixture", actorId: "test", expectedDraftRevision: 1 })).toEqual(first);
    expect(await service.publishPolicy({ id: "fixture", actorId: "test" })).toEqual(second);
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_event")).rows[0].count).toBe(2);
  });
  it("enforces unique draft identity while preserving historical versions without one", async () => {
    await service.publishPolicy({ id: "fixture", actorId: "test", expectedDraftRevision: 1 });
    await expect(pool.query("INSERT INTO policy_version (policy_id,version,snapshot,checksum,source_draft_revision) SELECT policy_id,2,snapshot,'duplicate',source_draft_revision FROM policy_version WHERE version=1")).rejects.toMatchObject({ code: "23505" });
    for (const version of [2, 3]) await pool.query("INSERT INTO policy_version (policy_id,version,snapshot,checksum) SELECT policy_id,$1,snapshot,$2 FROM policy_version WHERE version=1", [version, `published-${version}`]);
    expect((await pool.query("SELECT count(*)::int AS count FROM policy_version WHERE source_draft_revision IS NULL")).rows[0].count).toBe(2);
  });
});
