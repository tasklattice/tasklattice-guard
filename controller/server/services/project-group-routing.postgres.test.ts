// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { ControlPlaneService } from "./control-plane.js";
import { ProjectGroupRouting } from "./project-group-routing.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Project group Runner routing against PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let routing: ProjectGroupRouting;
  let control: ControlPlaneService;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "project_group_routing");
    await database.pool.query(`INSERT INTO project_group (id, name) VALUES ('beta', 'Beta');
      UPDATE project SET group_id = 'beta' WHERE id = 'projectB';
      INSERT INTO runner_pool (id, name, group_id, runtime_url, public_url) VALUES
       ('default', 'Default', 'default', null, null),
       ('beta-pool', 'Beta pool', 'beta', 'http://beta-runtime:8091', 'https://beta.example.test');
      UPDATE runner_pool SET project_id='projectB',name='runner-test-project-b' WHERE id='beta-pool';
      INSERT INTO controller_state (id, desired_generation) VALUES ('singleton', 4);
      INSERT INTO guardrail (id,project_id,name,draft_config,status) VALUES ('g-b','projectB','B guard','{}','active');`);
    const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/unused-key",
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
      CONTROLLER_RUNTIME_SERVICE_URL: "http://default-runtime:8091", CONTROLLER_RUNTIME_PUBLIC_URL: "https://default.example.test" });
    routing = new ProjectGroupRouting(database.db, config);
    control = new ControlPlaneService(database.db, config);
  });
  afterAll(async () => { await database?.drop(); });
  it("routes each project to its assigned group's pool, keeping legacy default addresses", async () => {
    await expect(routing.poolForProject("projectA")).resolves.toMatchObject({ groupId: "default", poolId: "default", runtimeUrl: "http://default-runtime:8091", publicUrl: "https://default.example.test" });
    await expect(routing.poolForProject("projectB")).resolves.toMatchObject({ groupId: "beta", poolId: "beta-pool", runtimeUrl: "http://beta-runtime:8091", publicUrl: "https://beta.example.test" });
    await expect(routing.poolForProject("missing")).rejects.toMatchObject({ code: "project_group_unavailable" });
  });
  it("dispatches validation only to pools belonging to the resource owner's group", async () => {
    expect(await routing.poolsForValidation("guardrail.validation_requested", "g-b")).toEqual(["beta-pool"]);
    expect(await routing.poolsForValidation("guardrail.validation_requested", "missing")).toEqual([]);
  });
  it("rejects an unallocated Runner pool before registering its process", async () => {
    const registration = { runnerId: "runner-test-project-b-0", bootId: "boot-1", poolId: "not-allocated", runnerVersion: "test", nemoVersion: "test", maxConcurrency: 1, compilerCapable: true, labels: {}, appliedGeneration: 0 };
    await expect(control.registerRunner(registration)).rejects.toThrow(/allocate it to a project group/);
    expect((await database.pool.query("select count(*)::int as n from runner_instance where runner_id = 'runner-test-project-b-0'")).rows[0].n).toBe(0);
    await expect(control.registerRunner({ ...registration, poolId: "beta-pool" })).resolves.toBe(4);
    expect((await database.pool.query("select pool_id from runner_instance where runner_id = 'runner-test-project-b-0'")).rows[0].pool_id).toBe("beta-pool");
  });
});
