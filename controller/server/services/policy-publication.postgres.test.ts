// Real transactions in an isolated schema on the explicitly selected local DB.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ControllerConfig } from "../config.js";
import * as schema from "../db/schema.js";
import { programmablePolicyDraftSchema } from "../policy-studio/model.js";
import { ControlPlaneService } from "./control-plane.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Policy publication identity in PostgreSQL", () => {
  const namespace = `guard_policy_publish_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool; let pool: Pool; let service: ControlPlaneService;
  const draft = programmablePolicyDraftSchema.parse({ guardrail_category: "content_safety", sources: [{ path: "main.co", content: "flow check $text\n  pass\n" }],
    rail_bindings: [{ rail_type: "input", flow_name: "check", execution_mode: "detect", on_unsafe: "reject" }],
    test_cases: [{ name: "safe", rail_type: "input", content: "ordinary", expected_decision: "allow", covered_rule_ids: ["flow/input/check"], case_type: "input_rail" }] });
  beforeAll(async () => {
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url!).hostname);
    admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000, options: `-c search_path=${namespace}`, application_name: namespace });
    for (const table of ["policy_record", "policy_version", "policy_validation_run", "audit_event"]) {
      await pool.query(`CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`);
    }
    // Test this migration against the old shape, even after public has upgraded.
    await pool.query("ALTER TABLE policy_version DROP COLUMN IF EXISTS source_draft_revision");
    await pool.query(readFileSync(new URL("../db/migrations/0005_policy_publication_identity.sql", import.meta.url), "utf8"));
    service = new ControlPlaneService(drizzle(pool, { schema }), {} as ControllerConfig);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin?.end();
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
    for (const version of [2, 3]) await pool.query("INSERT INTO policy_version (policy_id,version,snapshot,checksum) SELECT policy_id,$1,snapshot,$2 FROM policy_version WHERE version=1", [version, `legacy-${version}`]);
    expect((await pool.query("SELECT count(*)::int AS count FROM policy_version WHERE source_draft_revision IS NULL")).rows[0].count).toBe(2);
  });
});
