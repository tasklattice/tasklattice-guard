// @vitest-environment node
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
