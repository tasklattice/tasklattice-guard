import { migrateReportStorage } from "../db/report-storage-migration.js";
import { completeReport } from "../db/report-test-utils.js";
// @vitest-environment node
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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
describe.skipIf(!url).each([
  ["0052_curated_guardrail_profiles", "claims-assistant", 16],
  ["0053_full_feature_baseline_v2", "full-feature-baseline", 5],
] as const)("Profile migration %s preserves existing %s Guardrails", (migration, sourceId, profileCount) => {
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
    await completeReport(service, { runId: run.id, status: "failed", metrics: emptyValidationMetrics(run.metrics.total), results: [],
      failureReason: "Profile migration test fixture", candidateArtifact: {
        guardrailId, guardrailVersion: request.payload.candidateVersion, plan: request.payload.plan,
        compilerVersion: "tasklattice-nemo-config-v29-single-contract", nemoVersion: "0.24.0", runtimeProfile: "llmrails_colang1_standard",
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
      if (tag !== migration) return;
      // Build authentic old Profile content with the current service, then
      // restore the historical report schema before replaying the migration.
      await pool.query(readFileSync(new URL("../db/migrations/0055_bounded_testing_reports.sql", import.meta.url), "utf8"));
      await pool.query(readFileSync(new URL("../db/migrations/0056_unified_report_storage.sql",import.meta.url),"utf8"));
      await migrateReportStorage(drizzle(pool,{schema}));
      await pool.query(readFileSync(new URL("../db/migrations/0057_report_storage_cutover.sql",import.meta.url),"utf8"));
      const db = drizzle(pool, { schema });
      service = new ControlPlaneService(db, loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
        CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: join(keys, "private.pem"),
        CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
        CONTROLLER_PROTO_PATH: resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"),
        CONTROLLER_RUNNER_TOKEN: "profile-test-runner-token-32-characters", BETTER_AUTH_SECRET: "profile-test-auth-secret-32-characters" }));
      await pool.query("INSERT INTO auth_user (id,name,email,role) VALUES ('admin','Admin','admin@example.test','admin')");
      await service.initialize();
      const oldProfiles = await readGuardrailProfiles(db);
      expect(oldProfiles).toHaveLength(profileCount);
      const retired = oldProfiles.find(profile => profile.id === sourceId)!;
      const created = await service.createGuardrail({ name: "Existing Profile Guardrail", runtimeProfile: "auto", actorId: "admin",
        draftConfig: profileDraft(retired, await service.listPolicies()) });
      guardrailId = created.id;
      publishedVersion = await failTestsAndPublish(pool);
      await service.drainReportWork();
      await pool.query(`ALTER TABLE guardrail_validation_run ADD COLUMN results jsonb NOT NULL DEFAULT '[]', ADD COLUMN candidate_artifact jsonb, ADD COLUMN candidate_policies jsonb, ADD COLUMN candidate_inspection jsonb, ADD COLUMN test_suite jsonb;
        UPDATE guardrail_validation_run r SET candidate_artifact=nullif(s.payload->'candidateArtifact','null'),candidate_policies=nullif(s.payload->'candidatePolicies','null'),candidate_inspection=nullif(s.payload->'candidateInspection','null'),test_suite=nullif(s.payload->'testSuite','null') FROM guardrail_validation_snapshot s WHERE s.digest=r.snapshot_digest;
        DROP VIEW validation_report_state;
        DROP TRIGGER register_report ON guardrail_validation_run; DROP TRIGGER register_report ON policy_validation_run; DROP TRIGGER register_report ON policy_resource_validation;
        DROP FUNCTION register_validation_report();
        DROP TABLE validation_report_chunk,validation_report_upload,validation_report_case,validation_report_detail,validation_report;
        ALTER TABLE guardrail_validation_run DROP COLUMN snapshot_digest; DROP TABLE guardrail_validation_snapshot;
        ALTER TABLE policy_validation_run ADD COLUMN results jsonb NOT NULL DEFAULT '[]'; ALTER TABLE policy_resource_validation ADD COLUMN results jsonb NOT NULL DEFAULT '[]';`);
      before = await snapshots(pool);
    });
  }, 30000);
  afterAll(async () => {
    await service?.stopReportWork();
    await database?.drop();
    if (keys) rmSync(keys, { recursive: true, force: true });
  });

  it("changes discovery without rewriting existing drafts, tests, versions or signed artifacts", async () => {
    expect(await readGuardrailProfiles(database.db)).toEqual(defaultGuardrailProfiles);
    expect(await snapshots(database.pool)).toEqual(before);
    await service.initialize();
    expect(await snapshots(database.pool)).toEqual(before);

    const stored = await service.getGuardrail(guardrailId);
    expect(stored.draftConfig.profileOrigin).toEqual({ id: sourceId, version: "1.0.0" });
    const run = await service.requestVersionTestRun({ guardrailId, version: publishedVersion, actorId: "admin" });
    expect(run).toMatchObject({ subject: "version", status: "queued", guardrailVersion: publishedVersion });
    await completeReport(service, { runId: run.id, status: "failed", metrics: emptyValidationMetrics(run.metrics.total), results: [] });

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
