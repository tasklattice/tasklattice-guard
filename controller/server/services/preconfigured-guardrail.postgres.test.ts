// @vitest-environment node
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { ControlPlaneService } from "./control-plane.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Preconfigured Guardrail lifecycle", () => {
  if (!url) return;
  const directory = mkdtempSync(join(tmpdir(), "guard-preconfigured-"));
  const key = generateKeyPairSync("ed25519");
  const keyPath = join(directory, "artifact.pem");
  writeFileSync(keyPath, key.privateKey.export({ type: "pkcs8", format: "pem" }));
  const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url,
    CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
    CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: keyPath,
    CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
    CONTROLLER_PROTO_PATH: resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"),
    BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: string;
  beforeAll(async () => {
    database = await createTestDatabase(url, "preconfigured");
    await database.pool.query("INSERT INTO auth_user (id,name,email,role) VALUES ('user','User','user@example.test','user')");
  });
  afterAll(async () => { await database?.drop(); rmSync(directory, { recursive: true, force: true }); });

  it("seeds once, preserves edits and mode across restarts, and never restores deletion", async () => {
    let service = new ControlPlaneService(database.db, config);
    await service.initialize();
    id = (await database.pool.query("SELECT guardrail_id FROM deployment_preset")).rows[0].guardrail_id;
    expect(id).not.toBe("guardrail-default");
    const initial = await service.getGuardrail(id);
    expect(initial.draftConfig.policyBindings).toHaveLength(12);
    expect(initial.versions).toHaveLength(1);
    expect(initial.versions[0]!.testSuiteCount).toBe(748);
    expect(initial.versions[0]!.validationRunId).toBeNull();
    const artifact = initial.versions[0]!.artifact!;
    expect(verify(null, Buffer.from(artifact.checksum, "utf8"), key.publicKey, Buffer.from(artifact.signature, "base64"))).toBe(true);
    // No global baseline is delivered to unrelated pools.
    expect((await service.desiredStateForPool("secondary")).artifacts).toEqual([]);
    expect(await service.requiredPlatformModelBindings()).toEqual([]);

    const renamed = await service.updateGuardrail({ id, actorId: "user", name: "My local protections", expectedDraftRevision: initial.draftRevision,
      draftConfig: { ...initial.draftConfig, safetyLevel: "strict" } });
    const custom = await service.createTestCase({ guardrailId: id, actorId: "user", name: "My safe input", phase: "input", policyId: "local-credentials",
      content: "Hello there", expectedDecision: "allow", trustedInstruction: "", targetSource: "user_input", query: "", groundingSources: [], expectedReasoningResult: null });
    await service.protectionModes.update({ id, actorId: "user", mode: "monitor", expectedGeneration: 0, reason: "Review local protection" });
    const saved = await service.getGuardrail(id);
    await expect(service.requestGuardrailPublish({ guardrailId: id, actorId: "user", expectedDraftRevision: saved.draftRevision }))
      .rejects.toMatchObject({ code: "guardrail_compiler_unavailable" });
    service = new ControlPlaneService(database.db, config);
    await service.initialize();
    const restarted = await service.getGuardrail(id);
    expect(restarted.name).toBe(renamed.name);
    expect(restarted.draftConfig).toEqual(saved.draftConfig);
    expect(restarted.draftRevision).toBe(saved.draftRevision);
    expect(restarted.versions).toHaveLength(1);
    expect((await service.protectionModes.get(id)).mode).toBe("monitor");
    expect((await database.pool.query("SELECT id FROM guardrail_test_case WHERE id=$1", [custom.id])).rowCount).toBe(1);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM guardrail_validation_run WHERE guardrail_id=$1", [id])).rows[0].n).toBe(0);

    // A pending Router change protects Default with the ordinary reference check.
    const router = await service.trafficRouting.create("Explicit fallback", "", { routes: [{ id: "fallback", name: "Fallback", kind: "fallback", enabled: true,
      selector: { expression: { combinator: "and", conditions: [] } }, targets: [{ id: "target", guardrailId: id, guardrailVersion: initial.versions[0]!.version, weightBps: 10000 }] }] }, "user");
    const review = await service.trafficRouting.preview(router.id, 1);
    const change = await service.trafficRouting.submitChange(router.id, { expectedDraftRevision: 1, reviewedSnapshot: review.snapshot,
      reviewedEndpointIds: review.endpointIds, reason: "Pin explicit fallback", ticket: "TEST-1" }, "user");
    await expect(service.softDeleteGuardrail({ id, actorId: "user", reason: "Remove preset", confirmRecentTraffic: false })).rejects.toMatchObject({ code: "guardrail_in_use" });
    await service.trafficRouting.withdrawChange(router.id, change.id, "user");
    await service.trafficRouting.remove(router.id, "user");
    await service.softDeleteGuardrail({ id, actorId: "user", reason: "Remove unused preset", confirmRecentTraffic: false });
    await service.initialize();
    await expect(service.getGuardrail(id)).rejects.toMatchObject({ code: "not_found" });
    expect((await service.desiredStateForPool("default")).artifacts).toEqual([]);
    expect(await service.requiredPlatformModelBindings()).toEqual([]);
    expect((await database.pool.query("SELECT deleted_at,delete_reason FROM guardrail WHERE id=$1", [id])).rows[0]).toMatchObject({ deleted_at: expect.any(Date), delete_reason: "Remove unused preset" });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM guardrail_version WHERE guardrail_id=$1", [id])).rows[0].n).toBe(1);
  });
  it("removes a legacy global pointer without changing resources or Router targets", async () => {
    const upgrade = await createTestDatabase(url, "baseline_upgrade");
    try {
      const service = new ControlPlaneService(upgrade.db, config);
      await service.initialize();
      const id = (await upgrade.pool.query("SELECT guardrail_id FROM deployment_preset")).rows[0].guardrail_id;
      const guardrail = await service.getGuardrail(id);
      const version = guardrail.versions[0]!.version;
      const routes = { routes: [{ id: "fallback", name: "Fallback", kind: "fallback", enabled: true,
        targets: [{ id: "target", guardrailId: id, guardrailVersion: version, weightBps: 10000 }] }] };
      await upgrade.pool.query("INSERT INTO traffic_router (id,name,draft,active_snapshot,active_revision) VALUES ('router','Router',$1,$1,1)", [routes]);
      await upgrade.pool.query("ALTER TABLE controller_state ADD COLUMN baseline_version text");
      await upgrade.pool.query("UPDATE controller_state SET baseline_version=$1,desired_generation=11", [version]);
      await upgrade.pool.query("DELETE FROM controller_outbox");
      await upgrade.pool.query(readFileSync(new URL("../db/migrations/0048_remove_runtime_baseline.sql", import.meta.url), "utf8"));
      const state = (await upgrade.pool.query("SELECT * FROM controller_state")).rows[0];
      expect(state).not.toHaveProperty("baseline_version");
      expect(Number(state.desired_generation)).toBe(12);
      expect((await upgrade.pool.query("SELECT kind,payload FROM controller_outbox")).rows).toEqual([
        { kind: "runner.desired_state_changed", payload: { generation: 12 } },
      ]);
      expect((await upgrade.pool.query("SELECT active_snapshot FROM traffic_router WHERE id='router'")).rows[0].active_snapshot).toEqual(routes);
      expect((await service.getGuardrail(id)).versions).toEqual(guardrail.versions);
    } finally { await upgrade.drop(); }
  });

  it.each([false, true])("preserves legacy IDs and release provenance through migration (deleted: %s)", async deleted => {
    const legacy = await createTestDatabase(url, "legacy_preset", async (tag, pool) => {
      if (tag !== "0050_unified_guardrail_publication") return;
      await pool.query("INSERT INTO guardrail (id,name,draft_config,status,deleted_at) VALUES ('guardrail-default','Renamed legacy','{}','disabled',$1)", [deleted ? new Date() : null]);
      await pool.query(`INSERT INTO guardrail_version (guardrail_id,version,generation,status,runtime_profile,plan,released_at,platform_release,source_validation_run_id,test_waiver)
        VALUES ('guardrail-default','legacy',1,'ready','auto','{}',now(),'{"source":"bundled"}','original-failure','{"reason":"Historical quota exception","sourceTestStatus":"failed"}')`);
    });
    try {
      const service = new ControlPlaneService(legacy.db, config);
      await Promise.all([service.initialize(), service.initialize()]);
      expect((await legacy.pool.query("SELECT id,name,deleted_at FROM guardrail")).rows).toEqual([{ id: "guardrail-default", name: "Renamed legacy", deleted_at: deleted ? expect.any(Date) : null }]);
      expect((await legacy.pool.query("SELECT guardrail_id FROM deployment_preset")).rows).toEqual([{ guardrail_id: "guardrail-default" }]);
      const version = (await legacy.pool.query("SELECT status,publication,test_waiver,platform_release FROM guardrail_version")).rows[0];
      expect(version).toMatchObject({ status: "ready", publication: { source: "legacy", legacy: { sourceValidationRunId: "original-failure", testWaiver: { reason: "Historical quota exception", sourceTestStatus: "failed" } } }, platform_release: { source: "bundled" }, test_waiver: { reason: "Historical quota exception" } });
    } finally { await legacy.drop(); }
  });

});
