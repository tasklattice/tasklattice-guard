// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { emptyPolicyDefinition } from "../../shared/policy-definition.js";
import { PolicyResourceService } from "./policy-resources.js";
import { runWithProjectContext } from "./project-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Policy child ownership across representations", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: PolicyResourceService;
  const asProject = <T>(projectId: string, work: () => T) => runWithProjectContext({ projectId, role: "user" }, work);
  beforeAll(async () => {
    database = await createTestDatabase(url!, "policy_owner_boundary");
    service = new PolicyResourceService(database.db, resolve("../runner/toolkit/policy_library/assets"), () => []);
    const definition = emptyPolicyDefinition();
    definition.metadata.id = "policy-conflict";
    await database.pool.query("INSERT INTO policy_resource (id,project_id,definition,revision,maintainer) VALUES ($1,'projectA',$2,1,'Owner')", [definition.metadata.id, JSON.stringify(definition)]);
    await database.pool.query(`INSERT INTO policy_resource_validation (id,policy_id,revision,status,tests)
      VALUES ('private-report','policy-conflict',1,'passed','[]');
      INSERT INTO policy_resource_version (policy_id,version,revision,definition,view,digest)
      VALUES ('policy-conflict','v1',1,'{}','{"id":"policy-conflict","version":"v1"}','digest');`);
  }, 30000);
  afterAll(async () => { await database?.drop(); });

  it("permits the owner but rejects unrelated projects and recipient writes", async () => {
    await expect(asProject("projectA", () => service.report("policy-conflict"))).resolves.toMatchObject({ id: "private-report" });
    await expect(asProject("projectB", () => service.report("policy-conflict"))).rejects.toMatchObject({ code: "not_found" });
    await expect(asProject("projectB", () => service.get("policy-conflict"))).rejects.toMatchObject({ code: "not_found" });
    await expect(asProject("projectC", () => service.report("policy-conflict"))).rejects.toMatchObject({ code: "not_found" });
    await expect(asProject("projectB", () => service.publish("policy-conflict", 1, "actor"))).rejects.toMatchObject({ code: "not_found" });
    // Shipped definitions are intentionally platform catalog content.
    await expect(asProject("projectC", () => service.get("builtin-topic-safety"))).resolves.toMatchObject({ id: "builtin-topic-safety", revision: 0 });
  });

  it("hides root, version and report and rejects owner writes when another representation has a different owner", async () => {
    await database.pool.query(`INSERT INTO policy_imported_version (policy_id,version,project_id,digest,definition,source_id)
      VALUES ('policy-conflict','foreign','projectC','digest','{}','source')`);
    for (const project of ["projectA", "projectB", "projectC"]) {
      await expect(asProject(project, () => service.report("policy-conflict"))).rejects.toMatchObject({ code: "not_found" });
      await expect(asProject(project, () => service.get("policy-conflict"))).rejects.toMatchObject({ code: "not_found" });
      expect(await asProject(project, () => service.views([], undefined, "policy-conflict"))).toEqual([]);
    }
    await expect(asProject("projectA", () => service.publish("policy-conflict", 1, "actor"))).rejects.toMatchObject({ code: "not_found" });
    await expect(asProject("projectA", () => service.validate("policy-conflict", "actor", true))).rejects.toMatchObject({ code: "not_found" });
    const definition = emptyPolicyDefinition(); definition.metadata.id = "policy-conflict"; definition.metadata.name = "Policy conflict";
    await expect(asProject("projectA", () => service.save({ definition, maintainer: "Owner", expectedRevision: 1, actorId: "actor" })))
      .rejects.toMatchObject({ code: "not_found" });
    expect((await database.pool.query("SELECT revision FROM policy_resource WHERE id='policy-conflict'")).rows[0].revision).toBe(1);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM policy_resource_version WHERE policy_id='policy-conflict'")).rows[0].n).toBe(1);
    await database.pool.query("DELETE FROM policy_imported_version WHERE policy_id='policy-conflict'");
    await expect(asProject("projectB", () => service.report("policy-conflict"))).rejects.toMatchObject({ code: "not_found" });
    await database.pool.query(`INSERT INTO policy_record (id,project_id,name,owner,draft)
      VALUES ('policy-conflict','projectC','Legacy','Owner','{}')`);
    await expect(asProject("projectA", () => service.report("policy-conflict"))).rejects.toMatchObject({ code: "not_found" });
    await expect(asProject("projectB", () => service.get("policy-conflict"))).rejects.toMatchObject({ code: "not_found" });
    await expect(asProject("projectA", () => service.publish("policy-conflict", 1, "actor"))).rejects.toMatchObject({ code: "not_found" });
  });
});
