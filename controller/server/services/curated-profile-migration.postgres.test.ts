// @vitest-environment node
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import * as schema from "../db/schema.js";
import { loadConfig } from "../config.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { emptyValidationMetrics } from "../domain/validation.js";
import { profileDraft } from "../policy-catalog/presets.js";
import { ControlPlaneService } from "./control-plane.js";
import { readGuardrailProfiles } from "./guardrail-profiles.js";
import { defaultGuardrailProfiles } from "../../shared/guardrail-profiles.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Retiring built-in Profiles on an existing installation", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  let guardrailId: string;
  let publishedVersion: string;
  let before: unknown;
  let keys: string;

  async function snapshots(pool: Pool) {
    const result: Record<string, unknown> = {};
    for (const table of ["guardrail", "guardrail_version", "guardrail_artifact", "guardrail_test_case", "deployment_preset"]) {
      result[table] = (await pool.query(`SELECT to_jsonb(t) AS snapshot FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return result;
  }

  async function failTestsAndPublish(pool: Pool) {
    const run = await service.requestValidation({ guardrailId, actorId: "admin", compilerAvailable: true });
    const { rows: [request] } = await pool.query("SELECT payload FROM controller_outbox WHERE id=$1", [run.id]);
    await service.completeValidation({ runId: run.id, status: "failed", metrics: emptyValidationMetrics(run.metrics.total), results: [],
      failureReason: "Profile migration test fixture", candidateArtifact: {
        guardrailId, guardrailVersion: request.payload.candidateVersion, plan: request.payload.plan,
        compilerVersion: "profile-migration-test", nemoVersion: "0.24.0", runtimeProfile: "llmrails_colang1_standard",
        configYaml: "models: []\n", colangContent: "", prompts: [], actionBindings: [], dependencyManifest: [],
      } });
    const published = await service.requestGuardrailPublish({ guardrailId, actorId: "admin" });
    expect(published.status).toBe("ready");
    expect((await pool.query("SELECT status FROM guardrail_validation_run WHERE id=$1", [run.id])).rows[0].status).toBe("failed");
    return published.version!;
  }

  beforeAll(async () => {
    keys = mkdtempSync(join(tmpdir(), "guard-profile-upgrade-"));
    writeFileSync(join(keys, "private.pem"), generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
    database = await createTestDatabase(url!, "profile_upgrade", async (tag, pool) => {
      if (tag !== "0052_curated_guardrail_profiles") return;
      const db = drizzle(pool, { schema });
      service = new ControlPlaneService(db, loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
        CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: join(keys, "private.pem"),
        CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
        CONTROLLER_PROTO_PATH: resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"),
        CONTROLLER_RUNNER_TOKEN: "profile-test-runner-token-32-characters", BETTER_AUTH_SECRET: "profile-test-auth-secret-32-characters" }));
      await pool.query("INSERT INTO auth_user (id,name,email,role) VALUES ('admin','Admin','admin@example.test','admin')");
      await service.initialize();
      const oldProfiles = await readGuardrailProfiles(db);
      expect(oldProfiles).toHaveLength(16);
      const retired = oldProfiles.find(profile => profile.id === "claims-assistant")!;
      const created = await service.createGuardrail({ name: "Existing claims Guardrail", runtimeProfile: "auto", actorId: "admin",
        draftConfig: profileDraft(retired, await service.listPolicies()) });
      guardrailId = created.id;
      publishedVersion = await failTestsAndPublish(pool);
      before = await snapshots(pool);
    });
  }, 30000);
  afterAll(async () => {
    await database?.drop();
    if (keys) rmSync(keys, { recursive: true, force: true });
  });

  it("changes discovery without rewriting existing drafts, tests, versions or signed artifacts", async () => {
    expect(await readGuardrailProfiles(database.db)).toEqual(defaultGuardrailProfiles);
    expect(await snapshots(database.pool)).toEqual(before);
    await service.initialize();
    expect(await snapshots(database.pool)).toEqual(before);

    const stored = await service.getGuardrail(guardrailId);
    expect(stored.draftConfig.profileOrigin).toEqual({ id: "claims-assistant", version: "1.0.0" });
    const run = await service.requestVersionTestRun({ guardrailId, version: publishedVersion, actorId: "admin" });
    expect(run).toMatchObject({ subject: "version", status: "queued", guardrailVersion: publishedVersion });
    await service.completeValidation({ runId: run.id, status: "failed", metrics: emptyValidationMetrics(run.metrics.total), results: [] });

    const edited = structuredClone(stored.draftConfig);
    const removed = edited.policyBindings.shift()!;
    await service.updateGuardrail({ id: guardrailId, actorId: "admin", draftConfig: edited, expectedDraftRevision: stored.draftRevision });
    const updated = await service.getGuardrail(guardrailId);
    expect(updated.draftConfig.profileOrigin).toEqual(stored.draftConfig.profileOrigin);
    expect((await service.listTestCases(guardrailId)).some(test => test.sourcePolicyId === removed.policyId)).toBe(false);
    await service.previewGuardrailPlan({ draftConfig: updated.draftConfig, runtimeProfile: "auto" });
    expect(await failTestsAndPublish(database.pool)).not.toBe(publishedVersion);
    expect((await service.getGuardrail(guardrailId)).versions).toHaveLength(2);
  }, 30000);
});
