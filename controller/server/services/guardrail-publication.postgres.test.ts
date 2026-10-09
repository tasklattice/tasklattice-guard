// @vitest-environment node
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { canonicalArtifactContent } from "../control-channel/artifact-codec.js";
import { artifactContentDigest, verifyArtifactDigest, type ArtifactContent } from "../domain/artifact-content.js";
import { defaultGuardrailDraft } from "../domain/defaults.js";
import { emptyValidationMetrics } from "../domain/validation.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { testSuiteDigest } from "../domain/test-suite.js";
import { ControlPlaneService } from "./control-plane.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
const catalogDir = resolve("../runner/toolkit/policy_library/assets");
const protoPath = resolve("../proto/tasklattice/guard/control/v1/runner_control.proto");

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
      CONTROLLER_PROTO_PATH: protoPath,
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

    // The digest covers exactly what a Runner decodes from the wire.
    const digest = artifactContentDigest(canonicalArtifactContent(candidate, protoPath));
    const { rows: [artifact] } = await database.pool.query("SELECT * FROM guardrail_artifact WHERE guardrail_id = $1", [guardrail.id]);
    expect(artifact).toMatchObject({ checksum: digest, guardrail_version: run.guardrailVersion, content_digest_version: 2, generation: "4" });
    expect(verifyArtifactDigest(digest, artifact.signature, publicKey)).toBe(true);
    const { rows: [version] } = await database.pool.query("SELECT * FROM guardrail_version WHERE guardrail_id = $1", [guardrail.id]);
    expect(version).toMatchObject({ status: "ready", artifact_id: artifact.id, validation_run_id: run.id, inspection: run.candidateInspection });
    const { rows: [stored] } = await database.pool.query("SELECT status FROM guardrail WHERE id = $1", [guardrail.id]);
    expect(stored).toEqual({ status: "active" });
    const { rows: outbox } = await database.pool.query("SELECT kind FROM controller_outbox WHERE aggregate_id = $1 AND kind <> 'guardrail.validation_requested'", [guardrail.id]);
    expect(outbox).toEqual([{ kind: "runner.desired_state_changed" }]);

    // The version carries the exact suite the run executed and sent to the Runner.
    const { rows: [request] } = await database.pool.query("SELECT payload FROM controller_outbox WHERE id = $1", [run.id]);
    expect(version.test_suite).toEqual(request.payload.testCases);
    expect(version.test_suite).toHaveLength(run.metrics.total);
    expect(version.test_suite[0]).not.toHaveProperty("updatedAt");
    expect(testSuiteDigest(version.test_suite)).toBe(run.candidateInspection!.testSuite.digest);
    // Editing the Guardrail's cases afterwards never changes the published suite.
    await database.pool.query("UPDATE guardrail_test_case SET content = 'edited later' WHERE guardrail_id = $1", [guardrail.id]);
    const frozen = await service.guardrailVersionTestSuite(guardrail.id, run.guardrailVersion);
    expect(frozen).toMatchObject({ recorded: true, count: run.metrics.total, digest: run.candidateInspection!.testSuite.digest });
    expect(frozen.items.some(item => item.content === "edited later")).toBe(false);
    expect((await service.getGuardrail(guardrail.id)).versions[0]).toMatchObject({ testSuiteCount: run.metrics.total });
    expect((await service.getGuardrail(guardrail.id)).versions[0]).not.toHaveProperty("testSuite");

    // Testing the published version again runs its own suite against its signed Artifact, as it is.
    const versionRun = await service.requestVersionTestRun({ guardrailId: guardrail.id, version: run.guardrailVersion, actorId: "admin" });
    expect(versionRun).toMatchObject({ subject: "version", guardrailVersion: run.guardrailVersion, status: "queued", candidateDigest: digest });
    await expect(service.requestVersionTestRun({ guardrailId: guardrail.id, version: run.guardrailVersion, actorId: "admin" }))
      .rejects.toMatchObject({ code: "guardrail_version_test_running" });
    const { rows: [versionRequest] } = await database.pool.query("SELECT payload FROM controller_outbox WHERE id = $1", [versionRun.id]);
    expect(versionRequest.payload).toMatchObject({ candidateVersion: run.guardrailVersion, testCases: version.test_suite, artifact: { checksum: digest, signature: artifact.signature } });
    expect(versionRequest.payload).not.toHaveProperty("plan");
    await service.completeValidation({ runId: versionRun.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [] });
    const { rows: [tested] } = await database.pool.query("SELECT status, subject, candidate_digest, candidate_artifact FROM guardrail_validation_run WHERE id = $1", [versionRun.id]);
    expect(tested).toEqual({ status: "passed", subject: "version", candidate_digest: digest, candidate_artifact: null });
    // A version run says nothing about the draft.
    expect((await service.getGuardrail(guardrail.id)).latestValidationRun).toMatchObject({ id: run.id });

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
