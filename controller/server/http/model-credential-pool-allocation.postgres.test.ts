// @vitest-environment node
import { runnerAuthEnv } from "../../test/runner-auth-fixture.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Registry } from "prom-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { loadConfig } from "../config.js";
import type { ControllerAuth } from "../auth.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import { ModelConfigurationService } from "../model-config/service.js";
import { emptyModelAssignments } from "../model-config/domain.js";
import { encryptModelCredential } from "../model-config/secret-crypto.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
const rootSecret = "pool-allocation-test-root-secret";
const providerId = randomUUID(), candidateProviderId = randomUUID();
const modelId = randomUUID(), candidateModelId = randomUUID();
const poolToken = "pool-a-token-with-at-least-32-characters";
const staleToken = "deleted-pool-token-with-at-least-32-characters";
const authentication = runnerAuthEnv({ "pool-a": poolToken, "deleted-pool": staleToken });
const inboundHttpToken = JSON.parse(authentication.CONTROLLER_RUNNER_HTTP_TOKENS_JSON)["pool-a"] as string;

describe.skipIf(!url)("model credential current pool allocation", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let models: ModelConfigurationService;
  const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://unused:unused@localhost/unused",
    BETTER_AUTH_SECRET: "better-auth-secret-with-at-least-32-characters", ...authentication,
    CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem" });
  beforeAll(async () => {
    database = await createTestDatabase(url!, "credential_pool_allocation");
    const assignments = emptyModelAssignments();
    assignments.bindings["content_safety.input"] = modelId;
    await database.pool.query("INSERT INTO auth_user(id,username,email,role) VALUES ('credential-admin','Admin','credential-admin@test.invalid','admin')");
    await database.pool.query("INSERT INTO project_group(id,name) VALUES ('credential-group','Credential group')");
    for (const [id, name, secret] of [[providerId, "Active provider", "active-secret"], [candidateProviderId, "Candidate provider", "candidate-secret"]]) {
      await database.pool.query("INSERT INTO model_provider(id,name,kind,base_url,credential_ciphertext) VALUES ($1,$2,'custom-openai-compatible','https://provider.invalid',$3)",
        [id, name, encryptModelCredential(secret!, rootSecret)]);
    }
    for (const [id, provider, name] of [[modelId, providerId, "Active model"], [candidateModelId, candidateProviderId, "Candidate model"]]) {
      await database.pool.query("INSERT INTO model_definition(id,provider_id,name,model,profile) VALUES ($1,$2,$3,$3,'tali.qwen3guard.v1')", [id, provider, name]);
    }
    await database.pool.query("INSERT INTO model_configuration_revision(id,project_id,revision,state,generation,assignments) VALUES ('active-credential-revision',NULL,1,'active',1,$1)", [JSON.stringify(assignments)]);
  }, 30000);
  afterAll(async () => { await database?.drop(); });
  beforeEach(async () => {
    await database.pool.query("UPDATE project SET group_id='default' WHERE id='projectA'; INSERT INTO runner_pool(id,name,group_id,project_id) VALUES ('pool-a','Pool A','default','projectA') ON CONFLICT(id) DO UPDATE SET group_id='default'");
    models = new ModelConfigurationService(database.db, rootSecret, resolve("../runner/toolkit/policy_library/assets"),
      vi.fn(() => { throw new Error("No external calls allowed"); }));
  });
  const app = () => createHttpApp({ config, models, service: {} as ControlPlaneService,
    auth: { api: { getSession: vi.fn() } } as unknown as ControllerAuth, runnerControl: {} as RunnerControlServer,
    metrics: { registry: new Registry() } as ControllerMetrics });
  const request = async (token: string, refs = [providerId]) => app().request("/api/internal/v1/model-credentials/resolve", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ refs }),
  });
  it("serves assigned platform credentials to an allocated pool and denies stale or unassigned identities", async () => {
    expect(await (await request(poolToken)).json()).toEqual({ credentials: { [providerId]: "active-secret" } });
    expect(await (await request(poolToken, [candidateProviderId])).json()).toEqual({ credentials: {} });
    expect(await (await request(staleToken)).json()).toEqual({ credentials: {} });
    expect((await request(inboundHttpToken)).status).toBe(401);
    expect((await request("unknown-token")).status).toBe(401);
    await database.pool.query("DELETE FROM runner_pool WHERE id='pool-a'");
    expect(await (await request(poolToken)).json()).toEqual({ credentials: {} });
  });
  it("does not grant platform credentials to a non-default group without an explicit model grant", async () => {
    await database.pool.query("UPDATE project SET group_id='credential-group' WHERE id='projectA'; UPDATE runner_pool SET group_id='credential-group' WHERE id='pool-a'");
    expect(await (await request(poolToken)).json()).toEqual({ credentials: {} });
  });
  it("rechecks allocation in the secret fetch after an earlier successful lookup", async () => {
    const active = models.activeConfiguration.bind(models);
    vi.spyOn(models, "activeConfiguration").mockImplementationOnce(async includeActivating => {
      const configuration = await active(includeActivating);
      await database.pool.query("DELETE FROM runner_pool WHERE id='pool-a'");
      return configuration;
    });
    expect(await (await request(poolToken)).json()).toEqual({ credentials: {} });
  });
  it("does not fall back to active credentials for an unknown candidate lease", async () => {
    const response = await app().request("/api/internal/v1/model-credentials/resolve", {
      method: "POST", headers: { authorization: `Bearer ${poolToken}`, "content-type": "application/json" },
      body: JSON.stringify({ refs: [providerId], leaseId: "04017d29-f14e-45c9-9b6b-978db32f8a29" }),
    });
    expect(await response.json()).toEqual({ credentials: {} });
  });
  it("denies a candidate validation credential once its bound pool is deprovisioned", async () => {
    const session = { poolId: "pool-a", runnerId: "runner-a-0", bootId: "boot-a", sessionId: "session-a" };
    await database.pool.query("INSERT INTO runner_control_session(id,runner_id,boot_id,pool_id) VALUES ($1,$2,$3,$4)",
      [session.sessionId, session.runnerId, session.bootId, session.poolId]);
    await database.pool.query("INSERT INTO runner_instance(runner_id,boot_id,pool_id,runner_version,nemo_version,status,max_concurrency,control_session_id) VALUES ($1,$2,$3,'test','test','ready',1,$4)",
      [session.runnerId, session.bootId, session.poolId, session.sessionId]);
    models.setRailValidator(async validation => {
      expect(await models.bindValidationLease(validation.credentialLeaseId!, session.poolId, session)).toBe(true);
      expect(await models.resolveCredentials([candidateProviderId], validation.credentialLeaseId, "pool-a"))
        .toEqual({ [candidateProviderId]: "candidate-secret" });
      await database.pool.query("DELETE FROM runner_instance WHERE pool_id='pool-a'; DELETE FROM runner_control_session WHERE pool_id='pool-a'; DELETE FROM runner_pool WHERE id='pool-a'");
      expect(await models.resolveCredentials([candidateProviderId], validation.credentialLeaseId, "pool-a")).toEqual({});
      return { passed: true, message: "Synthetic validation", latencyMs: 1 };
    });
    await models.previewAssignment("content_safety.input", candidateModelId, "credential-admin");
  });
});
