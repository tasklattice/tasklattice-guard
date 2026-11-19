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
import type { ControlPlaneService } from "../services/control-plane.js";
import { modelDefinitions, modelProviders } from "../db/schema.js";
import { createHttpApp } from "../http/app.js";
import { emptyModelAssignments } from "./domain.js";
import { ModelConfigurationService } from "./service.js";
import { encryptModelCredential } from "./secret-crypto.js";
import { modelBindingValidationFingerprint, modelRuntimeValidationFingerprint } from "./runtime-fingerprint.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
const rootSecret = "group-runtime-tests-root-secret";
const providerA = randomUUID(), providerC = randomUUID(), modelA = randomUUID(), modelC = randomUUID();
const sourceA = randomUUID(), sourceC = randomUUID();
const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://unused:unused@localhost/unused",
  ...runnerAuthEnv("legacy-token-at-least-thirty-two-characters"), BETTER_AUTH_SECRET: "better-auth-secret-at-least-thirty-two-characters",
  ...runnerAuthEnv({ "pool-ab": "ab-pool-token-at-least-thirty-two-characters", "pool-c": "c-pool-token-at-least-thirty-two-characters" }),
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem" });

describe.skipIf(!url)("explicit group runtime Model grants", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let models: ModelConfigurationService;
  let fingerprintA: string, fingerprintC: string;
  const assignments = (modelId: string) => { const value = emptyModelAssignments(); value.bindings["content_safety.input"] = modelId; return value; };
  const validateSource = async (id: string, modelId: string, state = "validated") => {
    const selectedModels = await database.db.select().from(modelDefinitions);
    const providers = await database.db.select().from(modelProviders);
    const model = selectedModels.find(row => row.id === modelId)!, provider = providers.find(row => row.id === model.providerId)!;
    const binding = assignments(modelId);
    const fingerprint = modelRuntimeValidationFingerprint(binding, selectedModels, providers);
    const report = { valid: true, checkedAt: new Date().toISOString(), runtimeFingerprint: fingerprint,
      checks: [{ id: `probe:content_safety.input:${modelId}`, scope: "capability", status: "passed", evidenceKind: "nemo-rail-v1",
        runtimeFingerprint: modelBindingValidationFingerprint("content_safety.input", model, provider), message: "Synthetic passed Rail validation" }],
      contractCoverage: [], policies: [] };
    await database.pool.query(`INSERT INTO model_configuration_revision(id,project_id,revision,state,assignments,validation_report,validated_at,generation)
      VALUES ($1,NULL,$2,$3,$4,$5,now(),1) ON CONFLICT(id) DO UPDATE SET state=$3,assignments=$4,validation_report=$5,validated_at=now()`,
    [id, id === sourceA ? 1 : 2, state, JSON.stringify(binding), JSON.stringify(report)]);
    return fingerprint;
  };
  const grant = (groupId = "group-c", expectedVersion = 0, sourceRevisionId = sourceC, expectedSourceFingerprint = fingerprintC) =>
    models.groupRuntime.update(groupId, { mode: "scoped", expectedVersion, sourceRevisionId, expectedSourceFingerprint }, "group-model-admin");
  const credential = (refs: string[], pool = "pool-c") => models.resolveCredentials(refs, undefined, pool);
  const app = (role = "admin") => createHttpApp({ config, models, service: {} as ControlPlaneService,
    auth: { api: { getSession: vi.fn(async () => ({ user: { id: "group-model-admin", projectId: "projectA", role } })) } } as unknown as ControllerAuth,
    runnerControl: {} as RunnerControlServer, metrics: { registry: new Registry() } as ControllerMetrics });

  beforeAll(async () => {
    database = await createTestDatabase(url!, "group_runtime_models");
    await database.pool.query(`INSERT INTO auth_user(id,username,email,role) VALUES ('group-model-admin','Admin','group-model-admin@test.invalid','admin');
      INSERT INTO project_group(id,name) VALUES ('group-ab','A/B'),('group-c','C');
      INSERT INTO runner_pool(id,name,group_id,project_id) VALUES ('default','Default','default',NULL),('pool-ab','A/B','group-ab','projectA'),('pool-c','C','group-c','projectC');
      INSERT INTO controller_state(id,desired_generation) VALUES ('singleton',1) ON CONFLICT(id) DO NOTHING;`);
  }, 30000);
  beforeEach(async () => {
    // Trusted fixture reset, not an application deletion path.
    await database.pool.query(`TRUNCATE project_group_model_configuration; DELETE FROM model_configuration_revision;
      DELETE FROM model_definition; DELETE FROM model_provider; UPDATE controller_state SET desired_generation=1 WHERE id='singleton'`);
    await database.pool.query("UPDATE runner_pool_lease_epoch SET draining=false");
    for (const [id, name, secret] of [[providerA, "Provider A", "synthetic-a-key"], [providerC, "Provider C", "synthetic-c-key"]])
      await database.pool.query("INSERT INTO model_provider(id,name,kind,base_url,credential_ciphertext,status) VALUES ($1,$2,'custom-openai-compatible','https://provider.invalid',$3,'validated')",
        [id, name, encryptModelCredential(secret!, rootSecret)]);
    for (const [id, providerId, name] of [[modelA, providerA, "Model A"], [modelC, providerC, "Model C"]])
      await database.pool.query("INSERT INTO model_definition(id,provider_id,name,model,profile,status) VALUES ($1,$2,$3,$3,'tali.qwen3guard.v1','validated')", [id, providerId, name]);
    models = new ModelConfigurationService(database.db, rootSecret, resolve("../runner/toolkit/policy_library/assets"));
    fingerprintA = await validateSource(sourceA, modelA, "active");
    fingerprintC = await validateSource(sourceC, modelC);
  });
  afterAll(async () => { await database?.drop(); });

  it("blocks custom groups until explicitly granted without activating a draft globally", async () => {
    expect(await models.groupRuntime.view("group-c")).toMatchObject({ mode: "blocked", version: 0, grantId: null });
    expect((await models.configurationForPool("pool-c"))?.models).toEqual([]);
    expect(await credential([providerA])).toEqual({});
    const policy = await grant();
    const scoped = await models.configurationForPool("pool-c");
    expect(scoped?.revisionId).toBe(`project-group-model:${policy.grantId}`);
    expect(scoped?.models.map(row => row.id)).toEqual([modelC]);
    expect(scoped?.assignments.controlPlane).toBeNull();
    expect((await models.configurationForPool("pool-ab"))?.models).toEqual([]);
    expect((await models.activeConfiguration(true))?.revisionId).toBe(sourceA);
    expect(await credential([providerC])).toEqual({ [providerC]: "synthetic-c-key" });
    expect(await credential([providerA])).toEqual({});
    expect(await credential([providerC], "pool-ab")).toEqual({});
    expect(await credential([providerA, providerC])).toEqual({});
  });

  it("freezes source edits and Provider rotation until an explicit regrant", async () => {
    const first = await grant();
    await database.pool.query("UPDATE model_configuration_revision SET assignments=$2, validation_report=NULL WHERE id=$1", [sourceC, JSON.stringify(assignments(modelA))]);
    await database.pool.query("UPDATE model_provider SET credential_ciphertext=$2 WHERE id=$1", [providerC, encryptModelCredential("rotated-c-key", rootSecret)]);
    expect((await models.configurationForPool("pool-c"))?.models.map(row => row.id)).toEqual([modelC]);
    expect(await credential([providerC])).toEqual({ [providerC]: "synthetic-c-key" });
    await expect(grant("group-c", 1)).rejects.toThrow();
    const current = await validateSource(sourceC, modelC);
    const second = await grant("group-c", 1, sourceC, current);
    expect(second.grantId).not.toBe(first.grantId);
    expect(await credential([providerC])).toEqual({ [providerC]: "rotated-c-key" });
    const saved = (await database.pool.query("SELECT runtime_payload,credential_ciphertexts FROM project_group_model_configuration")).rows[0];
    expect(JSON.stringify(saved)).not.toContain("rotated-c-key");
  });

  it("freezes operational model concurrency until the group grant is explicitly refreshed", async () => {
    await models.configureRuntimeSettings(modelC, { maxConcurrency: 5 }, "group-model-admin");
    const first = await grant();
    expect((await models.configurationForPool("pool-c"))?.models[0]?.maxConcurrency).toBe(5);
    await models.configureRuntimeSettings(modelC, { maxConcurrency: 7 }, "group-model-admin");
    expect((await models.configurationForPool("pool-c"))?.models[0]?.maxConcurrency).toBe(5);
    const second = await grant("group-c", 1);
    expect(second.grantId).not.toBe(first.grantId);
    expect((await models.configurationForPool("pool-c"))?.models[0]?.maxConcurrency).toBe(7);
  });

  it("requires fresh validation before granting changed thresholds and keeps existing group settings frozen", async () => {
    await grant();
    const settings = { maxConcurrency: 4, rateLimitAttempts: 1, lowerThreshold: 0, upperThreshold: 0.8 };
    await models.configureRuntimeSettings(modelC, settings, "group-model-admin");
    expect((await models.configurationForPool("pool-c"))?.models[0]).toMatchObject({
      maxConcurrency: 2, rateLimitAttempts: 3, lowerThreshold: 0.1, upperThreshold: 0.9,
    });
    await expect(grant("group-c", 1)).rejects.toThrow();
    const refreshed = await validateSource(sourceC, modelC);
    expect(refreshed).not.toBe(fingerprintC);
    await grant("group-c", 1, sourceC, refreshed);
    expect((await models.configurationForPool("pool-c"))?.models[0]).toMatchObject(settings);
  });

  it("freezes the remote Laya request mode until a new group grant", async () => {
    await database.pool.query("UPDATE model_provider SET kind='laya' WHERE id=$1", [providerC]);
    await database.pool.query("UPDATE model_definition SET profile='tali.laya.v1', model='laya', laya_request_mode='compatible' WHERE id=$1", [modelC]);
    fingerprintC = await validateSource(sourceC, modelC);
    await grant("group-c", 0, sourceC, fingerprintC);
    expect((await models.configurationForPool("pool-c"))?.models[0]).toMatchObject({ id: modelC, layaRequestMode: "compatible" });
    await database.pool.query("UPDATE model_definition SET laya_request_mode='native' WHERE id=$1", [modelC]);
    expect((await models.configurationForPool("pool-c"))?.models[0]?.layaRequestMode).toBe("compatible");
    // Transport detail is not part of the validation fingerprint, so the mode
    // refresh only needs a new grant, not a new capability validation.
    await grant("group-c", 1, sourceC, fingerprintC);
    expect((await models.configurationForPool("pool-c"))?.models[0]).toMatchObject({ id: modelC, layaRequestMode: "native" });
  });

  it("revokes into blocked mode and rejects platform inheritance for custom groups", async () => {
    await grant();
    const blocked = await models.groupRuntime.update("group-c", { mode: "blocked", expectedVersion: 1 }, "group-model-admin");
    expect(blocked).toMatchObject({ mode: "blocked", version: 2, modelIds: [], providerIds: [] });
    expect(await credential([providerA, providerC])).toEqual({});
    expect(await models.configurationForPool("pool-c")).toMatchObject({ models: [], assignments: emptyModelAssignments() });
    await expect(models.groupRuntime.update("group-c", {mode:"platform",expectedVersion:2},"group-model-admin")).rejects.toThrow("Only the default group");
    expect(await credential([providerA])).toEqual({});
  });

  it("rejects stale source validation, private Models and stale policy versions", async () => {
    await expect(grant("group-c", 0, sourceC, "0".repeat(64))).rejects.toMatchObject({ code: "group_model_source_changed" });
    await database.pool.query("UPDATE model_definition SET timeout_seconds=99 WHERE id=$1", [modelC]);
    await expect(grant()).rejects.toMatchObject({ code: "group_model_validation_required" });
    fingerprintC = await validateSource(sourceC, modelC);
    await database.pool.query("UPDATE model_definition SET project_id='projectB' WHERE id=$1", [modelC]);
    await expect(grant()).rejects.toMatchObject({ code: "group_model_validation_required" });
    await database.pool.query("UPDATE model_definition SET project_id=NULL WHERE id=$1", [modelC]);
    const results = await Promise.allSettled([grant(), grant("group-c", 0, sourceA, fingerprintA)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM project_group_model_configuration")).rows[0].n).toBe(1);
  });

  it("protects grant-backed resources after their mutable source draft is edited or removed", async () => {
    await grant();
    await database.pool.query("DELETE FROM model_configuration_revision WHERE id=$1", [sourceC]);
    await expect(models.deleteModel(modelC, "group-model-admin")).rejects.toMatchObject({ code: "group_model_in_use" });
    await expect(models.configureModel(modelC, { profile: "tali.qwen3guard.v1", timeoutSeconds: 21, maxTokens: 512 }, "group-model-admin"))
      .rejects.toMatchObject({ code: "group_model_in_use" });
    // Simulate privileged external inventory corruption; the application path above refuses it.
    await database.pool.query("DELETE FROM model_definition WHERE id=$1", [modelC]);
    await expect(models.deleteProvider(providerC, "group-model-admin")).rejects.toMatchObject({ code: "group_model_provider_in_use" });
    expect(await credential([providerC])).toEqual({ [providerC]: "synthetic-c-key" });
  });

  it("enforces admin API permissions and redacts frozen credentials from every group response", async () => {
    const path = "/api/v1/project-groups/group-c/model-configuration";
    for (const role of ["user", "developer"]) {
      expect((await app(role).request(path)).status).toBe(403);
      expect((await app(role).request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "blocked", expectedVersion: 0 }) })).status).toBe(403);
    }
    const response = await app().request(path, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "scoped", expectedVersion: 0, sourceRevisionId: sourceC, expectedSourceFingerprint: fingerprintC }) });
    expect(response.status).toBe(200);
    const body = await response.text();
    for (const forbidden of ["synthetic-c-key", "credentialCiphertexts", "runtimePayload", "baseUrl"]) expect(body).not.toContain(forbidden);
    expect(await (await app().request(path)).json()).toMatchObject({ mode: "scoped", modelIds: [modelC], providerIds: [providerC] });
    await expect(database.pool.query("DELETE FROM project_group_model_configuration WHERE group_id='group-c'")).rejects.toThrow("explicitly");
    await expect(database.pool.query("UPDATE project_group_model_configuration SET version=version+1 WHERE group_id='group-c'")).rejects.toThrow("fresh identity");
  });

  it("uses only the default group for platform activation", async () => {
    expect(await models.groupRuntime.platformActivationPoolId()).toBe("default");
    await models.groupRuntime.update("default", { mode: "blocked", expectedVersion: 0 }, "group-model-admin");
    expect(await models.groupRuntime.platformActivationPoolId()).toBeNull();
    await models.groupRuntime.update("group-ab", { mode: "blocked", expectedVersion: 0 }, "group-model-admin");
    await grant();
    expect(await models.groupRuntime.platformActivationPoolId()).toBeNull();
  });

  it.each(["platform", "scoped"])("denies future %s configuration and active credentials during pool draining", async mode => {
    if (mode === "scoped") await grant();
    const provider = mode === "scoped" ? providerC : providerA;
    const poolId=mode === "scoped" ? "pool-c" : "default";
    expect(await credential([provider],poolId)).toHaveProperty(provider);
    await database.pool.query("INSERT INTO runner_pool_lease_epoch(pool_id,epoch,draining) VALUES ($1,0,true) ON CONFLICT(pool_id) DO UPDATE SET draining=true",[poolId]);
    expect(await credential([provider],poolId)).toEqual({});
    expect(await models.configurationForPool(poolId)).toBeNull();
    await database.pool.query("INSERT INTO runner_pool_lease_epoch(pool_id,epoch,draining) SELECT id,0,true FROM runner_pool ON CONFLICT(pool_id) DO UPDATE SET draining=true");
    expect(await models.groupRuntime.platformActivationPoolId()).toBeNull();
  });

  it.each(["blocked", "scoped"])("rejects stale platform ACK/NACK after the source pool changes to %s", async mode => {
    // A custom pool cannot acknowledge a platform activation.
    await database.pool.query("UPDATE model_configuration_revision SET state='activating',generation=2 WHERE id=$1", [sourceC]);
    await database.pool.query("UPDATE controller_state SET desired_generation=2 WHERE id='singleton'");
    if (mode === "blocked") await models.groupRuntime.update("group-c", { mode: "blocked", expectedVersion: 0 }, "group-model-admin");
    else await grant("group-c", 0, sourceA, fingerprintA);
    expect(await models.finalizeActivation(sourceC, "pool-c")).toBe(false);
    await models.failActivation(sourceC, "stale group rejection", "pool-c");
    expect((await database.pool.query("SELECT state,failure_reason FROM model_configuration_revision WHERE id=$1", [sourceC])).rows)
      .toEqual([{ state: "activating", failure_reason: null }]);
    // The default group can complete that exact global revision.
    expect(await models.finalizeActivation(sourceC, "default")).toBe(true);
    expect((await models.activeConfiguration())?.revisionId).toBe(sourceC);
  });

  it("serializes policy replacement behind the finalization authorization and commit", async () => {
    await database.pool.query("UPDATE model_configuration_revision SET state='activating',generation=2 WHERE id=$1", [sourceC]);
    await database.pool.query("UPDATE controller_state SET desired_generation=2 WHERE id='singleton'");
    const select = models.groupRuntime.selectionForPool.bind(models.groupRuntime);
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(models.groupRuntime, "selectionForPool").mockImplementationOnce(async (...args) => {
      const result = await select(...args); entered(); await proceed; return result;
    });
    const finalize = models.finalizeActivation(sourceC, "default");
    await observed;
    let switched = false;
    const replace = models.groupRuntime.update("default", { mode: "blocked", expectedVersion: 0 }, "group-model-admin")
      .then(value => { switched = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(switched).toBe(false);
    release();
    expect(await finalize).toBe(true);
    await replace;
    expect((await models.configurationForPool("default"))?.models).toEqual([]);
  });
});
