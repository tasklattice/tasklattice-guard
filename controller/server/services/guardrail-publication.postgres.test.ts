// @vitest-environment node
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { artifactContentDigest, verifyArtifactDigest, type ArtifactContent } from "../domain/artifact-content.js";
import { defaultGuardrailDraft } from "../domain/defaults.js";
import { emptyValidationMetrics } from "../domain/validation.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { ControlPlaneService } from "./control-plane.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
const catalogDir = resolve("../runner/toolkit/policy_library/assets");

describe.skipIf(!url)("Publishing the tested candidate in PostgreSQL", () => {
  const keys = mkdtempSync(join(tmpdir(), "guard-publication-"));
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(join(keys, "private.pem"), pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;

  beforeAll(async () => {
    database = await createTestDatabase(url!, "guard_publication");
    service = new ControlPlaneService(database.db, loadConfig({
      NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!, CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
      CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: join(keys, "private.pem"), CONTROLLER_POLICY_CATALOG_DIR: catalogDir,
      CONTROLLER_PROTO_PATH: resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"),
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
    }));
    await database.pool.query("INSERT INTO auth_user (id, name, email, role) VALUES ('admin', 'Admin', 'admin@example.test', 'admin')");
    await database.pool.query("INSERT INTO controller_state (id, desired_generation) VALUES ('singleton', 3)");
  });
  afterAll(async () => { await database?.drop(); rmSync(keys, { recursive: true, force: true }); });

  /** What a Runner returns: the compiled content of exactly the requested plan. */
  async function runnerCandidate(runId: string): Promise<ArtifactContent> {
    const { rows: [request] } = await database.pool.query("SELECT payload FROM controller_outbox WHERE id = $1", [runId]);
    return {
      guardrailId: request.payload.guardrailId, guardrailVersion: request.payload.candidateVersion, compilerVersion: "tasklattice-nemo-config-test",
      nemoVersion: "0.24.0", runtimeProfile: "llmrails_colang1_standard", plan: request.payload.plan,
      configYaml: "models: []\n", colangContent: "", prompts: [], actionBindings: [], dependencyManifest: [["action", "local", "1"]],
    };
  }

  it("publishes the exact tested content, signed locally, without compiling again", async () => {
    const draft = defaultGuardrailDraft(PolicyCatalog.load(catalogDir).list());
    const guardrail = await service.createGuardrail({ name: "Promotion fixture", draftConfig: draft, runtimeProfile: "auto", actorId: "admin" });
    const run = await service.requestValidation({ guardrailId: guardrail.id, actorId: "admin", compilerAvailable: true });
    expect(run.candidateInspection).toMatchObject({ name: "Promotion fixture", testSuite: { total: run.metrics.total } });
    const candidate = await runnerCandidate(run.id);
    await service.completeValidation({
      runId: run.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [], candidateArtifact: candidate,
      runtime: { runnerId: "runner-0", runnerVersion: "1.0.0", nemoVersion: "0.24.0", modelRevisionId: "", compilerModelTypes: [] },
    });

    const published = await service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "admin", expectedDraftRevision: 1 });
    expect(published).toMatchObject({ status: "ready", version: run.guardrailVersion, generation: 4 });

    const digest = artifactContentDigest(candidate);
    const { rows: [artifact] } = await database.pool.query("SELECT * FROM guardrail_artifact WHERE guardrail_id = $1", [guardrail.id]);
    expect(artifact).toMatchObject({ checksum: digest, guardrail_version: run.guardrailVersion, content_digest_version: 2, generation: "4" });
    expect(verifyArtifactDigest(digest, artifact.signature, publicKey)).toBe(true);
    const { rows: [version] } = await database.pool.query("SELECT * FROM guardrail_version WHERE guardrail_id = $1", [guardrail.id]);
    expect(version).toMatchObject({ status: "ready", artifact_id: artifact.id, validation_run_id: run.id, inspection: run.candidateInspection });
    const { rows: [stored] } = await database.pool.query("SELECT status, latest_version, latest_artifact_id FROM guardrail WHERE id = $1", [guardrail.id]);
    expect(stored).toEqual({ status: "active", latest_version: run.guardrailVersion, latest_artifact_id: artifact.id });
    const { rows: outbox } = await database.pool.query("SELECT kind FROM controller_outbox WHERE aggregate_id = $1 AND kind <> 'guardrail.validation_requested'", [guardrail.id]);
    expect(outbox).toEqual([{ kind: "runner.desired_state_changed" }]);

    // Publishing the same tested revision again is idempotent.
    await expect(service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "admin" }))
      .resolves.toMatchObject({ version: run.guardrailVersion, status: "ready" });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM guardrail_artifact WHERE guardrail_id = $1", [guardrail.id])).rows[0].n).toBe(1);
  });

  it("turns a passed run whose candidate differs from the request into a failure", async () => {
    const draft = defaultGuardrailDraft(PolicyCatalog.load(catalogDir).list());
    const guardrail = await service.createGuardrail({ name: "Tampered fixture", draftConfig: draft, runtimeProfile: "auto", actorId: "admin" });
    const run = await service.requestValidation({ guardrailId: guardrail.id, actorId: "admin", compilerAvailable: true });
    const candidate = await runnerCandidate(run.id);
    (candidate.plan.steps as Array<{ on_unsafe: string }>)[0]!.on_unsafe = "allow";
    await service.completeValidation({ runId: run.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [], candidateArtifact: candidate });
    const { rows: [stored] } = await database.pool.query("SELECT status, failure_reason, candidate_artifact FROM guardrail_validation_run WHERE id = $1", [run.id]);
    expect(stored).toMatchObject({ status: "failed", failure_reason: expect.stringContaining("does not match"), candidate_artifact: null });
    await expect(service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "admin" })).rejects.toMatchObject({ code: "guardrail_validation_required" });
  });
});
