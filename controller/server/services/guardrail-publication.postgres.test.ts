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
  it("counts pending and released versions, admits the tenth atomically, and frees slots only on deletion", async () => {
    const draft = defaultGuardrailDraft(PolicyCatalog.load(catalogDir).list());
    const guardrail = await service.createGuardrail({ name: "Version quota", draftConfig: draft, runtimeProfile: "auto", actorId: "admin" });
    await database.pool.query(`INSERT INTO guardrail_version (guardrail_id, version, generation, status, runtime_profile, plan, released_at)
      SELECT $1, 'retained-' || n, -n, CASE WHEN n % 2 = 0 THEN 'ready' ELSE 'pending' END, 'auto', '{}'::jsonb, CASE WHEN n % 2 = 0 THEN now() ELSE NULL END FROM generate_series(1, 9) n`, [guardrail.id]);
    const pass = async () => {
      const run = await service.requestValidation({ guardrailId: guardrail.id, actorId: "admin", compilerAvailable: true });
      await service.completeValidation({ runId: run.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [], candidateArtifact: await runnerCandidate(run.id) });
      return run;
    };
    const tenth = await pass();
    const request = () => service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "admin", expectedDraftRevision: 1 });
    // Simultaneous retries produce the same tenth version, with no duplicate slot/artifact.
    const releases = await Promise.all([request(), request()]);
    expect(releases.map(item => item.version)).toEqual([tenth.guardrailVersion, tenth.guardrailVersion]);
    const count = async () => Number((await database.pool.query("SELECT count(*) FROM guardrail_version WHERE guardrail_id=$1", [guardrail.id])).rows[0].count);
    expect(await count()).toBe(10);
    const next = await pass();
    const before = (await database.pool.query("SELECT desired_generation FROM controller_state")).rows;
    await expect(request()).rejects.toMatchObject({ code: "guardrail_version_limit", detail: { current: 10, incoming: 1, limit: 10 } });
    expect(await count()).toBe(10);
    expect((await database.pool.query("SELECT desired_generation FROM controller_state")).rows).toEqual(before);
    expect((await database.pool.query("SELECT id FROM guardrail_artifact WHERE guardrail_id=$1 AND guardrail_version=$2", [guardrail.id, next.guardrailVersion])).rows).toEqual([]);
    await service.deleteGuardrailVersion({ guardrailId: guardrail.id, version: "retained-1", actorId: "admin" });
    expect(await count()).toBe(9);
    await expect(request()).resolves.toMatchObject({ version: next.guardrailVersion });
    expect(await count()).toBe(10);
  });

  async function releasedFixture() {
    const draft = defaultGuardrailDraft(PolicyCatalog.load(catalogDir).list());
    draft.policyBindings = draft.policyBindings.filter(item => item.policyId === "local-network-addresses");
    const guardrail = await service.createGuardrail({ name: "Report lifecycle", draftConfig: draft, runtimeProfile: "auto", actorId: "admin" });
    const run = await service.requestValidation({ guardrailId: guardrail.id, actorId: "admin", compilerAvailable: true });
    await service.completeValidation({ runId: run.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [], candidateArtifact: await runnerCandidate(run.id) });
    const version = await service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "admin", expectedDraftRevision: 1 });
    return { guardrail, run, version };
  }
  async function versionReport(guardrailId: string, version: string, status: "passed" | "failed" = "passed") {
    const run = await service.requestVersionTestRun({ guardrailId, version, actorId: "admin" });
    await service.completeValidation({ runId: run.id, status, metrics: emptyValidationMetrics(run.metrics.total), results: [] });
    return run;
  }

  it("derives resource readiness from retained versions and matching evidence, independently of draft and latest test", async () => {
    const { guardrail, run, version } = await releasedFixture();
    const summary = () => service.getGuardrail(guardrail.id);
    expect(await summary()).toMatchObject({ readiness: "ready", versionSummary: { total: 1, released: 1, pending: 0, missingEvidence: 0 } });
    await versionReport(guardrail.id, version.version, "failed");
    await database.pool.query("UPDATE guardrail SET draft_revision=draft_revision+1, draft_config=jsonb_set(draft_config, '{allowedTopics}', $2::jsonb) WHERE id=$1", [guardrail.id, JSON.stringify(["Changed business scope"])]);
    expect(await summary()).toMatchObject({ readiness: "ready", hasUnpublishedChanges: true });
    // A historical lifecycle flag or Passed label alone cannot manufacture readiness.
    await database.pool.query("UPDATE guardrail_validation_run SET test_suite_digest='wrong' WHERE id=$1", [run.id]);
    expect(await summary()).toMatchObject({ status: "active", readiness: "not_ready", versionSummary: { total: 1, released: 0, missingEvidence: 1 } });
    await database.pool.query("UPDATE guardrail_validation_run SET test_suite_digest=$2 WHERE id=$1", [run.id, run.testSuiteDigest]);
    expect(await summary()).toMatchObject({ readiness: "ready" });
    await service.deleteGuardrailVersion({ guardrailId: guardrail.id, version: version.version, actorId: "admin" });
    expect(await summary()).toMatchObject({ status: "draft", readiness: "not_ready", versionSummary: { total: 0, released: 0 } });
    expect((await service.listValidationRuns(guardrail.id)).length).toBeGreaterThan(0);
  });

  it("does not mark a passed draft or a passed Pending version Ready before publication", async () => {
    const draft = defaultGuardrailDraft(PolicyCatalog.load(catalogDir).list());
    draft.policyBindings = draft.policyBindings.filter(item => item.policyId === "local-network-addresses");
    const guardrail = await service.createGuardrail({ name: "Readiness gates", draftConfig: draft, runtimeProfile: "auto", actorId: "admin" });
    const run = await service.requestValidation({ guardrailId: guardrail.id, actorId: "admin", compilerAvailable: true });
    await service.completeValidation({ runId: run.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [], candidateArtifact: await runnerCandidate(run.id) });
    expect(await service.getGuardrail(guardrail.id)).toMatchObject({ readiness: "not_ready", versionSummary: { total: 0 } });
    const version = await service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "admin", expectedDraftRevision: 1 });
    await service.deleteTestingReport({ runId: run.id, actorId: "admin", expectedPendingVersion: version.version });
    await versionReport(guardrail.id, version.version);
    expect(await service.getGuardrail(guardrail.id)).toMatchObject({ readiness: "not_ready", versionSummary: { total: 1, pending: 1 } });
    await service.releaseGuardrailVersion({ guardrailId: guardrail.id, version: version.version, actorId: "admin" });
    expect(await service.getGuardrail(guardrail.id)).toMatchObject({ readiness: "ready", versionSummary: { total: 1, released: 1 } });
  });

  it("keeps registry report summaries separate from draft testing and replaces deleted release evidence", async () => {
    const { guardrail, run, version } = await releasedFixture();
    const second = await versionReport(guardrail.id, version.version);
    expect(await service.getGuardrail(guardrail.id)).toMatchObject({ latestTestingReport: { id: second.id, subject: "version" }, latestValidationRun: { id: run.id, subject: "draft" } });
    expect(await service.testingReportDeletionImpact(run.id)).toMatchObject({ deletable: true, pendingVersion: null, replacementRunId: second.id });
    await service.deleteTestingReport({ runId: run.id, actorId: "admin", expectedPendingVersion: null });
    await expect(service.getValidationRun(run.id)).rejects.toMatchObject({ status: 404 });
    expect((await database.pool.query("SELECT status, validation_run_id FROM guardrail_version WHERE guardrail_id=$1", [guardrail.id])).rows).toEqual([{ status: "ready", validation_run_id: second.id }]);
    expect((await database.pool.query("SELECT id FROM controller_outbox WHERE id=$1", [run.id])).rows).toEqual([]);
    expect(await service.getGuardrail(guardrail.id)).toMatchObject({ latestTestingReport: { id: second.id }, latestValidationRun: null, hasUnpublishedChanges: false });
    const failed = await versionReport(guardrail.id, version.version, "failed");
    await service.deleteTestingReport({ runId: failed.id, actorId: "admin", expectedPendingVersion: null });
    expect(await service.getGuardrail(guardrail.id)).toMatchObject({ latestTestingReport: { id: second.id } });
  });

  it("returns a version to pending when its last matching Passed report is deleted, preserving frozen content", async () => {
    const { guardrail, run, version } = await releasedFixture();
    const before = (await database.pool.query("SELECT artifact_id, plan, test_suite, inspection FROM guardrail_version WHERE guardrail_id=$1", [guardrail.id])).rows;
    expect(await service.testingReportDeletionImpact(run.id)).toMatchObject({ deletable: true, pendingVersion: version.version });
    await service.deleteTestingReport({ runId: run.id, actorId: "admin", expectedPendingVersion: version.version });
    expect((await database.pool.query("SELECT status, validation_run_id, released_at, released_by FROM guardrail_version WHERE guardrail_id=$1", [guardrail.id])).rows).toEqual([{ status: "pending", validation_run_id: null, released_at: null, released_by: null }]);
    expect((await database.pool.query("SELECT artifact_id, plan, test_suite, inspection FROM guardrail_version WHERE guardrail_id=$1", [guardrail.id])).rows).toEqual(before);
    expect(await service.getGuardrail(guardrail.id)).toMatchObject({ status: "draft", latestTestingReport: null });
    const audit = (await database.pool.query("SELECT detail FROM audit_event WHERE resource_id=$1 AND kind='guardrail.testing_report_deleted'", [guardrail.id])).rows[0];
    expect(audit.detail).toMatchObject({ runId: run.id, pendingVersion: version.version });
    await expect(service.releaseGuardrailVersion({ guardrailId: guardrail.id, version: version.version, actorId: "admin" })).rejects.toMatchObject({ code: "guardrail_version_test_required" });
    await service.completeValidation({ runId: run.id, status: "passed", metrics: emptyValidationMetrics(0), results: [] });
    expect((await service.listValidationRuns(guardrail.id))).toEqual([]);
    const newReport = await versionReport(guardrail.id, version.version);
    expect(await service.releaseGuardrailVersion({ guardrailId: guardrail.id, version: version.version, actorId: "admin" })).toMatchObject({ status: "ready", validationRunId: newReport.id });
  });

  it("does not count a Passed report with mismatched content or test suite as release evidence", async () => {
    const { guardrail, run, version } = await releasedFixture();
    const wrong = await versionReport(guardrail.id, version.version);
    await database.pool.query("UPDATE guardrail_validation_run SET test_suite_digest='wrong-suite' WHERE id=$1", [wrong.id]);
    expect(await service.testingReportDeletionImpact(run.id)).toMatchObject({ pendingVersion: version.version, replacementRunId: null });
    await database.pool.query("UPDATE guardrail_validation_run SET test_suite_digest=$2, candidate_digest='wrong-content' WHERE id=$1", [wrong.id, run.testSuiteDigest]);
    expect(await service.testingReportDeletionImpact(run.id)).toMatchObject({ pendingVersion: version.version, replacementRunId: null });
  });

  it("protects the last Passed report referenced by a Router and rejects running report deletion", async () => {
    const { guardrail, run, version } = await releasedFixture();
    await service.trafficRouting.create("Evidence protection", "", { routes: [{ id: "fallback", name: "Fallback", kind: "fallback", enabled: true,
      selector: { expression: { combinator: "and", conditions: [] } }, targets: [{ id: "target", guardrailId: guardrail.id, guardrailVersion: version.version, weightBps: 10000 }] }] }, "admin");
    expect(await service.testingReportDeletionImpact(run.id)).toMatchObject({ deletable: false, pendingVersion: version.version, references: [expect.objectContaining({ kind: "router_draft" })] });
    await expect(service.deleteTestingReport({ runId: run.id, actorId: "admin", expectedPendingVersion: version.version })).rejects.toMatchObject({ code: "test_report_in_use" });
    const running = await service.requestVersionTestRun({ guardrailId: guardrail.id, version: version.version, actorId: "admin" });
    expect(await service.testingReportDeletionImpact(running.id)).toMatchObject({ running: true, deletable: false });
    await expect(service.deleteTestingReport({ runId: running.id, actorId: "admin", expectedPendingVersion: null })).rejects.toMatchObject({ code: "test_report_in_use" });
    await service.completeValidation({ runId: running.id, status: "passed", metrics: emptyValidationMetrics(running.metrics.total), results: [] });
    // References do not block deleting redundant evidence.
    await service.deleteTestingReport({ runId: run.id, actorId: "admin", expectedPendingVersion: null });
  });

  it("rechecks concurrent report deletions against the confirmed version impact", async () => {
    const { guardrail, run, version } = await releasedFixture();
    const second = await versionReport(guardrail.id, version.version);
    const result = await Promise.allSettled([run.id, second.id].map(runId => service.deleteTestingReport({ runId, actorId: "admin", expectedPendingVersion: null })));
    expect(result.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(result.find(item => item.status === "rejected")).toMatchObject({ reason: { code: "test_report_deletion_changed" } });
    expect(await service.listValidationRuns(guardrail.id)).toHaveLength(1);
    expect((await database.pool.query("SELECT status FROM guardrail_version WHERE guardrail_id=$1", [guardrail.id])).rows).toEqual([{ status: "ready" }]);
  });

});
