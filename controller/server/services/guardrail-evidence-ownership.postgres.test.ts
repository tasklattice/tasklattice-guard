// @vitest-environment node
import { runnerAuthEnv } from "../../test/runner-auth-fixture.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { loadConfig } from "../config.js";
import { ControlPlaneService } from "./control-plane.js";
import { runWithProjectContext } from "./project-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
const version = "20261105-1512.000Z";

describe.skipIf(!url)("Guardrail evidence ownership", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  const asProject = <T>(projectId: string, fn: () => T) => runWithProjectContext({ projectId, role: "user" }, fn);

  beforeAll(async () => {
    database = await createTestDatabase(url!, "guardrail_evidence_owner");
    service = new ControlPlaneService(database.db, loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      ...runnerAuthEnv("runner-token-that-is-at-least-32-characters"), CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key",
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" }));
    await database.pool.query("INSERT INTO guardrail(id,project_id,name,draft_config) VALUES ('owned-evidence','projectA','Owned','{}')");
    await database.pool.query(`INSERT INTO guardrail_version(guardrail_id,version,generation,status,runtime_profile,plan,policies,test_suite,released_at)
      VALUES ('owned-evidence',$1,1,'ready','auto','{}','[]',$2,now())`, [version, JSON.stringify([{ id: "case", content: "OWNED CASE" }])]);
  }, 30000);
  afterAll(async () => { await database?.drop(); });

  it("keeps version plans, frozen suites and reports inside the owning Project", async () => {
    const detail = await asProject("projectA", () => service.getGuardrail("owned-evidence"));
    expect(detail.versions[0]).toMatchObject({ testSuiteCount: 1, plan: {}, policies: [] });
    const suite = await asProject("projectA", () => service.guardrailVersionTestSuite("owned-evidence", version));
    expect(suite.items).toEqual([{ id: "case", content: "OWNED CASE" }]);
    // Guardrails are Project-scoped: there is no share path to another project.
    await expect(asProject("projectB", () => service.getGuardrail("owned-evidence"))).rejects.toMatchObject({ code: "not_found" });
    await expect(asProject("projectB", () => service.guardrailVersionTestSuite("owned-evidence", version))).rejects.toMatchObject({ code: "not_found" });
  });
});
