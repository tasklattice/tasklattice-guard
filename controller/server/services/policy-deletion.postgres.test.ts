import { withTestProject } from "../db/postgres-test-database.js";
// @vitest-environment node
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ControllerConfig } from "../config.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { normalizeGuardrailDraft } from "../domain/guardrail-plan.js";
import { emptyPolicyDefinition } from "../../shared/policy-definition.js";
import { ControlPlaneService } from "./control-plane.js";
import { queryAuditEvents } from "./audit-events.js";
import { runWithProjectContext } from "./project-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Policy deletion in PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "policy_deletion");
    await database.pool.query("INSERT INTO auth_user (id, name, email, role) VALUES ('test', 'Test', 'test@example.test', 'user')");
    service = new ControlPlaneService(database.db, { policyCatalogDir: resolve("../runner/toolkit/policy_library/assets") } as ControllerConfig);
  });
  afterAll(async () => { await database?.drop(); });
  async function create(id: string) {
    const definition = emptyPolicyDefinition();
    definition.metadata.id = id; definition.metadata.name = id;
    await withTestProject(() => service.policyResources.save({ definition, maintainer: "Test", expectedRevision: 0, actorId: "test", create: true }));
    return definition;
  }
  const remove = (id: string) => service.deletePolicy({ id, actorId: "test" });

  it("deletes a Rules draft and all owned history without resurrecting imported versions", async () => {
    const id = "deletion-complete";
    const definition = await create(id);
    const view = await service.getPolicy(id);
    expect(view).toMatchObject({ implementation: "rules", deletable: true });
    expect((await service.listPolicies()).find(p => p.id === id)).toMatchObject({ deletable: true });
    await database.pool.query("INSERT INTO policy_resource_version (policy_id,version,revision,definition,view,digest) VALUES ($1,'r1',1,$2,$3,'test')", [id, definition, view]);
    await database.pool.query("INSERT INTO policy_imported_version (project_id,policy_id,version,digest,definition,source_id) VALUES ('projectA',$1,'imported','test',$2,'test')", [id, { ...view, version: "imported" }]);
    await database.pool.query("INSERT INTO policy_resource_validation (id,policy_id,parent_id,revision,status,tests) VALUES ('report',$1,NULL,1,'passed','[]'),('job',$1,'report',1,'passed','[]')", [id]);
    await database.pool.query("INSERT INTO controller_outbox (id,kind,aggregate_id,payload) VALUES ('job','policy.validation_requested',$1,'{}')", [id]);
    await remove(id);
    await expect(withTestProject(() => service.policyResources.save({ definition, maintainer: "Test", expectedRevision: 1, actorId: "test" }))).rejects.toMatchObject({ code: "policy_draft_conflict" });
    await expect(service.getPolicy(id)).rejects.toMatchObject({ code: "not_found" });
    expect((await service.listPolicies()).some(p => p.id === id)).toBe(false);
    for (const table of ["policy_resource_version", "policy_imported_version", "policy_resource_validation"]) {
      expect((await database.pool.query(`SELECT * FROM ${table} WHERE policy_id=$1`, [id])).rows).toHaveLength(0);
    }
    expect((await database.pool.query("SELECT * FROM controller_outbox WHERE aggregate_id=$1", [id])).rows).toHaveLength(0);
    expect((await database.pool.query("SELECT detail FROM audit_event WHERE kind='policy.deleted' AND resource_id=$1", [id])).rows).toEqual([{ detail: { name: id } }]);
  });

  it.each(["draft", "version", "profile"])("preserves a Rules Policy referenced by a %s", async kind => {
    const id = `deletion-${kind}`; await create(id);
    if (kind === "profile") {
      await database.pool.query("INSERT INTO guardrail_profile (id,category,category_name,definition) VALUES ($1,'general','General',$2)", [id, { name: "Profile", policies: [{ policyId: id }], optionalPolicyIds: [] }]);
    } else {
      const draft = normalizeGuardrailDraft({ policyBindings: kind === "draft" ? [{ policyId: id, policyVersion: "0" }] : [] });
      await database.pool.query("INSERT INTO guardrail (project_id,id,name,draft_config) VALUES ('projectA',$1,'Reference',$2)", [id, draft]);
      if (kind === "version") await database.pool.query("INSERT INTO guardrail_version (guardrail_id,version,generation,status,runtime_profile,plan,released_at) VALUES ($1,'v1',1,'ready','auto',$2,now())", [id, { policy_bindings: [{ policy_id: id, policy_version: "0" }] }]);
    }
    await expect(remove(id)).rejects.toMatchObject({ code: "policy_in_use" });
    expect(await service.getPolicy(id)).toMatchObject({ id });
    expect((await database.pool.query("SELECT * FROM audit_event WHERE kind='policy.deleted' AND resource_id=$1", [id])).rows).toHaveLength(0);
  });

  it("protects in-flight testing, then permits deletion after completion", async () => {
    const id = "deletion-running"; await create(id);
    await database.pool.query("INSERT INTO policy_resource_validation (id,policy_id,revision,status,tests) VALUES ($1,$1,1,'running','[]')", [id]);
    await expect(remove(id)).rejects.toMatchObject({ code: "policy_validation_in_progress" });
    await database.pool.query("UPDATE policy_resource_validation SET status='failed' WHERE policy_id=$1", [id]);
    await remove(id);
    await expect(service.getPolicy(id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps system Policies protected and returns not found for an absent resource", async () => {
    const builtin = (await service.listPolicies()).find(p => p.id === "local-payment-data")!;
    expect(builtin.deletable).toBe(false);
    await expect(remove(builtin.id)).rejects.toThrow("system managed");
    await expect(remove("no-such-policy")).rejects.toMatchObject({ code: "not_found" });
  });

  it("records the locked Policy owner, not the platform administrator's project, after hard deletion", async () => {
    const definition = emptyPolicyDefinition();
    definition.metadata.id = "policy-owned-c"; definition.metadata.name = "Private C policy";
    await database.pool.query("INSERT INTO auth_user (id,name,email,role) SELECT id,name,email,role FROM (VALUES ('admin-a','projectA','Admin','admin-a@example.test','admin')) AS fixture(id,project_id,name,email,role)");
    await database.pool.query("INSERT INTO policy_resource (id,project_id,definition,maintainer) VALUES ('policy-owned-c','projectC',$1,'C')", [definition]);
    await runWithProjectContext({ projectId: "projectA", role: "admin" }, () => service.deletePolicy({ id: "policy-owned-c", actorId: "admin-a" }));
    const audit = (await database.pool.query("SELECT project_id FROM audit_event WHERE kind='policy.deleted' AND resource_id='policy-owned-c'")).rows;
    expect(audit).toEqual([{ project_id: "projectC" }]);
    const query = { window: "all" as const, q: "policy-owned-c" };
    expect((await runWithProjectContext({ projectId: "projectA", role: "user" }, () => queryAuditEvents(database.db, query))).total).toBe(0);
    expect((await runWithProjectContext({ projectId: "projectC", role: "user" }, () => queryAuditEvents(database.db, query))).total).toBe(1);
  });

  it("does not delete Policy records when a matching ID has conflicting owners", async () => {
    const definition = emptyPolicyDefinition();
    definition.metadata.id = "policy-conflicting-owner"; definition.metadata.name = "A policy";
    await database.pool.query("INSERT INTO policy_resource (id,project_id,definition,maintainer) VALUES ($1,'projectA',$2,'A')", [definition.metadata.id, definition]);
    await database.pool.query("INSERT INTO policy_imported_version (policy_id,project_id,version,digest,definition,source_id) VALUES ($1,'projectC','v1','digest','{}','test')", [definition.metadata.id]);
    await expect(runWithProjectContext({ projectId: "projectA", role: "user" }, () => remove(definition.metadata.id)))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(runWithProjectContext({ projectId: "projectA", role: "admin" }, () => remove(definition.metadata.id)))
      .rejects.toMatchObject({ code: "policy_owner_conflict", message: "Policy ownership is inconsistent. Contact a platform administrator before deleting it." });
    expect((await database.pool.query("SELECT project_id FROM policy_resource WHERE id=$1", [definition.metadata.id])).rows).toEqual([{ project_id: "projectA" }]);
    expect((await database.pool.query("SELECT project_id FROM policy_imported_version WHERE policy_id=$1", [definition.metadata.id])).rows).toEqual([{ project_id: "projectC" }]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM audit_event WHERE kind='policy.deleted' AND resource_id=$1", [definition.metadata.id])).rows).toEqual([{ count: 0 }]);
  });

  it("waits for a concurrent package import before checking Policy ownership", async () => {
    const definition = emptyPolicyDefinition();
    definition.metadata.id = "policy-concurrent-import"; definition.metadata.name = "A policy";
    await database.pool.query("INSERT INTO policy_resource (id,project_id,definition,maintainer) VALUES ($1,'projectA',$2,'A')", [definition.metadata.id, definition]);
    const importer = await database.pool.connect();
    try {
      await importer.query("BEGIN");
      await importer.query("SELECT pg_advisory_xact_lock(hashtext('guardrail-package-import'))");
      const deletion = runWithProjectContext({ projectId: "projectA", role: "user" }, () => remove(definition.metadata.id));
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const result = await database.pool.query("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=(hashtext('guardrail-package-import')::bigint & 4294967295)) AS waiting");
        waiting = result.rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await importer.query("INSERT INTO policy_imported_version (policy_id,project_id,version,digest,definition,source_id) VALUES ($1,'projectC','v1','digest','{}','test')", [definition.metadata.id]);
      await importer.query("COMMIT");
      await expect(deletion).rejects.toMatchObject({ code: "policy_owner_conflict" });
      expect((await database.pool.query("SELECT project_id FROM policy_imported_version WHERE policy_id=$1", [definition.metadata.id])).rows).toEqual([{ project_id: "projectC" }]);
    } finally {
      await importer.query("ROLLBACK");
      importer.release();
    }
  });
});
