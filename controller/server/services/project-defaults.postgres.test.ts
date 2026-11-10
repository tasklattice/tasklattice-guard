// @vitest-environment node
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { loadConfig } from "../config.js";
import { ControlPlaneService } from "./control-plane.js";
import { ProjectService } from "./projects.js";
import { runWithProjectContext } from "./project-context.js";
import { protectionPresets } from "../../shared/protection-presets.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { profileDraft } from "../policy-catalog/presets.js";
import { createAuth } from "../auth.js";
import { BootstrapAccountSynchronizer } from "../bootstrap.js";
import { freezeTestSuite } from "../domain/test-suite.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Project Default Guardrail provisioning", () => {
  const keys = generateKeyPairSync("ed25519");
  let directory: string;
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  let projects: ProjectService;
  let auth: ReturnType<typeof createAuth>;
  const inProject = <T>(projectId: string, callback: () => T) => runWithProjectContext({ projectId, role: "user" }, callback);
  const defaults = async () => (await database.pool.query("SELECT id,project_id,name FROM guardrail WHERE project_id IS NOT NULL ORDER BY project_id")).rows;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "guard-project-defaults-"));
    const keyPath = join(directory, "artifact.pem");
    writeFileSync(keyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
    database = await createTestDatabase(url!, "project_defaults");
    await database.pool.query("INSERT INTO auth_user(id,username,email,role) VALUES ('admin','Admin','admin@example.test','admin')");
    const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
      CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: keyPath,
      CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
      CONTROLLER_PROTO_PATH: resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"),
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
    service = new ControlPlaneService(database.db, config);
    projects = new ProjectService(database.db, (tx, id) => service.initializeProject(tx, id), "http://default-runner:8091");
    auth = createAuth(config, database.db);
    await service.initialize();
  });
  afterAll(async () => { await database?.drop(); if (directory) rmSync(directory, { recursive: true, force: true }); });

  it("backfills each existing Project exactly once even with concurrent startup", async () => {
    await Promise.all([service.initializeProjects(), service.initializeProjects()]);
    const rows = await defaults();
    expect(rows.map(row => [row.project_id, row.name])).toEqual([["projectA", "Default"], ["projectB", "Default"], ["projectC", "Default"]]);
    expect(new Set(rows.map(row => row.id)).size).toBe(3);
    for (const row of rows) {
      const guardrail = await inProject(row.project_id, () => service.getGuardrail(row.id));
      expect(guardrail.readiness).toBe("ready");
      expect(guardrail.versions).toHaveLength(1);
      const expectedSuite = freezeTestSuite((await inProject(row.project_id, () => service.listTestCases(row.id))).filter(test => !test.excluded));
      expect(expectedSuite.length).toBeGreaterThan(0);
      expect(guardrail.versions[0]!.testSuiteCount).toBe(expectedSuite.length);
      expect((await inProject(row.project_id, () => service.guardrailVersionTestSuite(row.id, guardrail.versions[0]!.version))).items).toEqual(expectedSuite);
      const artifact = guardrail.versions[0]!.artifact!;
      expect(verify(null, Buffer.from(artifact.checksum, "utf8"), keys.publicKey, Buffer.from(artifact.signature, "base64"))).toBe(true);
    }
    await expect(inProject("projectA", () => service.getGuardrail(rows[1].id))).rejects.toMatchObject({ code: "not_found" });
  });

  it("copies reviewed Profile exclusions on creation and preserves later scope edits", async () => {
    const profile = protectionPresets.find(p => p.id === "default")!;
    const draft = profileDraft(profile, PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list());
    const created = await inProject("projectA", () => service.createGuardrail({ name: "Reviewed Profile", draftConfig: draft, runtimeProfile: "auto", actorId: "admin" }));
    const [row] = (await database.pool.query("SELECT excluded_test_case_ids FROM guardrail WHERE id=$1", [created.id])).rows;
    expect(row.excluded_test_case_ids).toHaveLength(20);
    const [audit] = (await database.pool.query("SELECT detail FROM audit_event WHERE resource_id=$1 AND kind='guardrail.created'", [created.id])).rows;
    expect(audit.detail.profileTestExclusions).toEqual(profile.testExclusions);
    expect(audit.detail.excludedTestCaseIds).toEqual(row.excluded_test_case_ids);
    // A saved Guardrail owns its scope; a restart must not reapply Profile defaults.
    await database.pool.query("UPDATE guardrail SET excluded_test_case_ids='[]' WHERE id=$1", [created.id]);
    await service.initializeProjects();
    expect((await database.pool.query("SELECT excluded_test_case_ids FROM guardrail WHERE id=$1", [created.id])).rows[0].excluded_test_case_ids).toEqual([]);
    await inProject("projectA", () => service.softDeleteGuardrail({ id: created.id, actorId: "admin", reason: "Test cleanup", confirmRecentTraffic: false }));
    // Keep the shared fixture's resource inventory unchanged for following tests.
    await database.pool.query("DELETE FROM guardrail_test_case WHERE guardrail_id=$1", [created.id]);
    await database.pool.query("DELETE FROM guardrail WHERE id=$1", [created.id]);
  });

  it("creates a new Project and its published Default in one transaction", async () => {
    await projects.create("admin", { name: " New_Project " });
    const row = (await defaults()).find(item => item.project_id === "new-project");
    expect(row).toMatchObject({ name: "Default" });
    expect((await inProject("new-project", () => service.getGuardrail(row.id))).readiness).toBe("ready");
    const failing = new ProjectService(database.db, async (tx, id) => {
      await service.initializeProject(tx, id);
      throw new Error("Abort provisioning");
    });
    await expect(failing.create("admin", { name: "failed-project" })).rejects.toThrow("Abort provisioning");
    expect((await database.pool.query("SELECT id FROM project WHERE id='failed-project'")).rowCount).toBe(0);
    expect((await database.pool.query("SELECT id FROM guardrail WHERE project_id='failed-project'")).rowCount).toBe(0);
    expect((await database.pool.query("SELECT scope_key FROM default_guardrail_provisioning WHERE scope_key='project:failed-project'")).rowCount).toBe(0);
  });

  it("bootstraps a local user into its configured shared Project and preserves resources on restart", async () => {
    const config = { bootstrapAdmin: null, bootstrapUser: {
      username: "user", password: "password", project: " Local_Project ",
    } };
    const synchronizer = new BootstrapAccountSynchronizer(auth, projects);
    await synchronizer.synchronize(config);
    const login = await auth.api.signInUsername({ body: { username: "user", password: "password" } });
    const sessions = await database.pool.query("SELECT active_project_id FROM auth_session WHERE user_id=$1", [login.user.id]);
    expect(sessions.rows[0].active_project_id).toBe("local-project");
    expect(await projects.accessStatus(login.user.id, "local-project")).toMatchObject({ state: "ready" });
    const page = await projects.list({ limit: 25 }, login.user.id);
    expect(page.items).toEqual([expect.objectContaining({ name: "local-project", poolId: "default" })]);
    const original = (await defaults()).find(row => row.project_id === "local-project")!;
    expect(original.name).toBe("Default");
    await inProject("local-project", () => service.updateGuardrail({ id: original.id, name: "User edits", actorId: login.user.id }));
    expect(await synchronizer.synchronize(config)).toEqual([]);
    await new BootstrapAccountSynchronizer(auth, projects).synchronize(config);
    expect((await defaults()).filter(row => row.project_id === "local-project"))
      .toEqual([{ ...original, name: "User edits" }]);
    expect((await projects.list({ limit: 25 }, login.user.id)).items[0]?.memberCount).toBe(1);
    await expect(projects.ensureBootstrapMembership("user", "test-project-b"))
      .resolves.toBeUndefined();
    await service.projectGroups.createPool("default", { projectId: "local-project", runtimeUrl: "http://dedicated.invalid" }, "admin");
    await expect(projects.ensureBootstrapMembership("user", "local-project")).rejects.toThrow("default shared Runner");
  });

  it("preserves project edits and deletion when startup runs again", async () => {
    const rows = await defaults();
    const first = rows.find(row => row.project_id === "projectA")!;
    const second = rows.find(row => row.project_id === "projectC")!;
    await inProject("projectA", () => service.updateGuardrail({ id: first.id, name: "My default", actorId: "admin" }));
    await inProject("projectC", () => service.softDeleteGuardrail({ id: second.id, actorId: "admin", reason: "Remove unused default", confirmRecentTraffic: false }));
    await service.initializeProjects();
    expect((await defaults()).find(row => row.id === first.id)?.name).toBe("My default");
    expect((await defaults()).filter(row => row.project_id === "projectC")).toHaveLength(1);
    await expect(inProject("projectC", () => service.getGuardrail(second.id))).rejects.toMatchObject({ code: "not_found" });
  });

  it("preloads verified Project Defaults only into their allocated Runner pool", async () => {
    const pool = await service.projectGroups.createPool("default", { projectId: "projectB", runtimeUrl: "http://dedicated.invalid" }, "admin");
    const row = (await defaults()).find(item => item.project_id === "projectB")!;
    expect((await service.desiredStateForPool(pool.id)).artifacts).toEqual([]);
    // Simulate successful Runner load checks; provisioning itself must not bypass them.
    await database.pool.query(`UPDATE guardrail_version SET environment_check='{"status":"compatible"}'
      WHERE guardrail_id IN (SELECT id FROM guardrail WHERE project_id IS NOT NULL)`);
    expect((await service.desiredStateForPool(pool.id)).artifacts.map(artifact => artifact.guardrailId)).toEqual([row.id]);
    expect((await service.desiredStateForPool("default")).artifacts.some(artifact => artifact.guardrailId === row.id)).toBe(false);
  });
});
