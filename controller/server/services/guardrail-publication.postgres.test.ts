// @vitest-environment node
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { canonicalArtifactContent } from "../control-channel/artifact-codec.js";
import { artifactContentDigest, verifyArtifactDigest, type ArtifactContent } from "../domain/artifact-content.js";
import { defaultGuardrailDraft } from "../domain/defaults.js";
import { emptyValidationMetrics } from "../domain/validation.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { testSuiteDigest } from "../domain/test-suite.js";
import { ControlPlaneService } from "./control-plane.js";
import { pruneTestingReportHistory } from "./testing-report-retention.js";
import { fullFeatureBaseline } from "../../shared/full-feature-baseline.js";
import { profileDraft } from "../policy-catalog/presets.js";
import type { ArtifactCompilation } from "../domain/artifact-compilation.js";
import { parsePackage } from "../domain/guardrail-package.js";

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
    await expect(service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "admin" })).rejects.toMatchObject({ code: "guardrail_compiler_unavailable" });
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
    const request = () => service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "admin", });
    // Simultaneous retries produce the same tenth version, with no duplicate slot/artifact.
    const releases = await Promise.all([request(), request()]);
    expect(releases.map(item => item.version)).toEqual([tenth.guardrailVersion, tenth.guardrailVersion]);
    const count = async () => Number((await database.pool.query("SELECT count(*) FROM guardrail_version WHERE guardrail_id=$1", [guardrail.id])).rows[0].count);
    expect(await count()).toBe(10);
    await database.pool.query("UPDATE guardrail SET draft_revision=draft_revision+1 WHERE id=$1", [guardrail.id]);
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

  async function seedHistory(guardrailId: string, prefix: string, status: "passed" | "failed" | "queued" | "running", count: number, version: string | null = null) {
    await database.pool.query(`INSERT INTO guardrail_validation_run
      (id, guardrail_id, guardrail_version, source_draft_revision, status, subject, created_at, completed_at, results)
      SELECT $2 || '-' || n, $1, coalesce($5::text, 'unpublished-candidate-' || n), 1, $3, CASE WHEN $5::text IS NULL THEN 'draft' ELSE 'version' END,
        now() + n * interval '1 second', CASE WHEN $3 IN ('passed', 'failed') THEN now() + n * interval '1 second' ELSE NULL END,
        jsonb_build_array(jsonb_build_object('body', repeat('x', 4096))) FROM generate_series(1, $4::int) n`, [guardrailId, prefix, status, count, version]);
    await database.pool.query(`INSERT INTO controller_outbox (id, kind, aggregate_id, payload)
      SELECT id, 'guardrail.validation_requested', guardrail_id, jsonb_build_object('body', repeat('x', 4096))
      FROM guardrail_validation_run WHERE guardrail_id=$1 AND starts_with(id, $2)`, [guardrailId, prefix]);
  }

  it("retains 2 Passed + 1 Failed independently for all 10 versions, plus a bounded draft history", async () => {
    const { guardrail, version } = await releasedFixture();
    const versions = [version.version];
    for (let index = 1; index < 10; index++) {
      await database.pool.query("UPDATE guardrail SET draft_revision=draft_revision+1 WHERE id=$1", [guardrail.id]);
      const run = await service.requestValidation({ guardrailId: guardrail.id, actorId: "admin", compilerAvailable: true });
      await service.completeValidation({ runId: run.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [], candidateArtifact: await runnerCandidate(run.id) });
      versions.push((await service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "admin" })).version);
    }
    for (const [index, versionId] of versions.entries()) {
      await seedHistory(guardrail.id, `version-${index}-passed`, "passed", 4, versionId);
      await seedHistory(guardrail.id, `version-${index}-failed`, "failed", 3, versionId);
    }
    await seedHistory(guardrail.id, "retention-passed", "passed", 9);
    await seedHistory(guardrail.id, "retention-failed", "failed", 508);
    await seedHistory(guardrail.id, "retention-queued", "queued", 1);
    await seedHistory(guardrail.id, "retention-running", "running", 1);
    const other = await releasedFixture();
    await pruneTestingReportHistory(database.db);
    const reports = (await service.queryValidationRuns({ guardrailId: guardrail.id, limit: 100 })).items;
    for (const [index, versionId] of versions.entries()) {
      const own = reports.filter(run => run.guardrailVersion === versionId);
      expect(own.filter(run => run.status === "passed").map(run => run.id).sort()).toEqual([3, 4].map(n => `version-${index}-passed-${n}`));
      expect(own.filter(run => run.status === "failed").map(run => run.id)).toEqual([`version-${index}-failed-3`]);
    }
    const drafts = reports.filter(run => !versions.includes(run.guardrailVersion));
    expect(drafts.filter(run => run.status === "passed").map(run => run.id).sort()).toEqual([8, 9].map(n => `retention-passed-${n}`));
    expect(drafts.filter(run => run.status === "failed").map(run => run.id)).toEqual(["retention-failed-508"]);
    expect(reports).toHaveLength(35);
    expect(await service.listValidationRuns(other.guardrail.id)).toHaveLength(1);
    const summary = await service.getGuardrail(guardrail.id);
    expect(summary).toMatchObject({ readiness: "ready", versionSummary: { total: 10, released: 10, pending: 0, missingEvidence: 0 } });
    expect(summary.versions.every(item => item.testingEvidence?.release?.id === item.validationRunId)).toBe(true);
    expect(JSON.stringify(summary.versions.map(item => item.testingEvidence))).not.toMatch(/results|testSuite"|candidateArtifact/);
    const requests = (await database.pool.query("SELECT id FROM controller_outbox WHERE aggregate_id=$1 AND kind='guardrail.validation_requested'", [guardrail.id])).rows;
    expect(requests.map(item => item.id).sort()).toEqual(reports.map(item => item.id).sort());
    const exported = parsePackage((await service.packages.exportPackage(guardrail.id, versions)).bytes);
    expect(JSON.stringify(exported.manifest)).not.toContain("testingEvidence");
    // Resetting local operational data must also revoke the compact evidence.
    await service.softDeleteGuardrail({ id: guardrail.id, actorId: "admin", reason: "retention reset test", confirmRecentTraffic: false });
    const reset = (await database.pool.query("SELECT status, testing_evidence FROM guardrail_version WHERE guardrail_id=$1", [guardrail.id])).rows;
    expect(reset).toHaveLength(10);
    expect(reset.every(row => row.status === "pending" && row.testing_evidence === null)).toBe(true);
  }, 30_000);

  it("replaces only the same version's previous failure and oldest success, independently of other versions and drafts", async () => {
    const { guardrail, version, run: publication } = await releasedFixture();
    const pass1 = await versionReport(guardrail.id, version.version);
    await database.pool.query("UPDATE guardrail SET draft_revision=draft_revision+1 WHERE id=$1", [guardrail.id]);
    const candidate = await service.requestValidation({ guardrailId: guardrail.id, actorId: "admin", compilerAvailable: true });
    await service.completeValidation({ runId: candidate.id, status: "passed", metrics: emptyValidationMetrics(candidate.metrics.total), results: [], candidateArtifact: await runnerCandidate(candidate.id) });
    const otherVersion = await service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "admin" });
    const failure1 = await versionReport(guardrail.id, version.version, "failed");
    const failure2 = await versionReport(guardrail.id, version.version, "failed");
    const otherFailure = await versionReport(guardrail.id, otherVersion.version, "failed");
    const rows = () => service.listValidationRuns(guardrail.id);
    expect((await rows()).map(run => run.id).sort()).toEqual([publication.id, pass1.id, candidate.id, failure2.id, otherFailure.id].sort());
    await expect(service.getValidationRun(failure1.id)).rejects.toMatchObject({ status: 404 });
    expect((await database.pool.query("SELECT id FROM controller_outbox WHERE id=$1", [failure1.id])).rows).toEqual([]);
    const pass2 = await versionReport(guardrail.id, version.version);
    expect((await rows()).map(run => run.id).sort()).toEqual([pass1.id, pass2.id, candidate.id, failure2.id, otherFailure.id].sort());
    const summary = await service.getGuardrail(guardrail.id);
    expect(summary).toMatchObject({ readiness: "ready", versionSummary: { released: 2 } });
    expect(summary.versions.find(row => row.version === version.version)?.testingEvidence?.release?.id).toBe(publication.id);
    await seedHistory(guardrail.id, "separate-draft-failures", "failed", 8);
    await pruneTestingReportHistory(database.db);
    expect((await rows()).filter(run => run.subject === "version" && run.status === "failed").map(run => run.id).sort()).toEqual([failure2.id, otherFailure.id].sort());
    // Late delivery of the replaced failure must not recreate its report or change the remaining failure.
    await service.completeValidation({ runId: failure1.id, status: "passed", metrics: emptyValidationMetrics(0), results: [] });
    await expect(service.getValidationRun(failure1.id)).rejects.toMatchObject({ status: 404 });
    // Publication does not change a failed test outcome.
    await database.pool.query("UPDATE guardrail_version SET status='pending', validation_run_id=NULL, released_at=NULL WHERE guardrail_id=$1 AND version=$2", [guardrail.id, otherVersion.version]);
    await expect(service.releaseGuardrailVersion({ guardrailId: guardrail.id, version: otherVersion.version, actorId: "admin" }))
      .resolves.toMatchObject({ status: "ready", validationRunId: null });
    expect(await service.getValidationRun(otherFailure.id)).toMatchObject({ status: "failed" });
    const nextPass = await versionReport(guardrail.id, otherVersion.version);
    expect(await service.releaseGuardrailVersion({ guardrailId: guardrail.id, version: otherVersion.version, actorId: "admin" })).toMatchObject({ status: "ready", validationRunId: null });
    // Removed versions join the separate history bucket immediately, without evicting another version's reports.
    const otherReports = (await rows()).filter(run => run.guardrailVersion === otherVersion.version).map(run => run.id).sort();
    await service.deleteGuardrailVersion({ guardrailId: guardrail.id, version: version.version, actorId: "admin" });
    expect((await rows()).filter(run => run.guardrailVersion === otherVersion.version).map(run => run.id).sort()).toEqual(otherReports);
    const history = (await rows()).filter(run => run.guardrailVersion !== otherVersion.version);
    expect(history.filter(run => run.status === "passed")).toHaveLength(2);
    expect(history.filter(run => run.status === "failed")).toHaveLength(1);
  });

  it("serializes concurrent completions and duplicate deliveries without exceeding retention or repeating completion", async () => {
    const { guardrail, version } = await releasedFixture();
    await seedHistory(guardrail.id, "concurrent-retention", "queued", 12);
    await database.pool.query("UPDATE guardrail_validation_run SET subject='version', guardrail_version=$2 WHERE guardrail_id=$1 AND starts_with(id, 'concurrent-retention-')", [guardrail.id, version.version]);
    const input = (n: number) => ({ runId: `concurrent-retention-${n}`, status: "passed" as const, metrics: emptyValidationMetrics(0), results: [] });
    await Promise.all(Array.from({ length: 12 }, (_, n) => service.completeValidation(input(n + 1))));
    await Promise.all(Array.from({ length: 12 }, (_, n) => service.completeValidation(input(n + 1))));
    expect(await service.listValidationRuns(guardrail.id)).toHaveLength(2);
    expect(await service.getGuardrail(guardrail.id)).toMatchObject({ readiness: "ready" });
    const completed = (await database.pool.query("SELECT detail->>'runId' AS id, count(*)::int AS n FROM audit_event WHERE resource_id=$1 AND kind='guardrail.validation_completed' GROUP BY detail->>'runId'", [guardrail.id])).rows;
    expect(completed).toHaveLength(13);
    expect(completed.every(row => row.n === 1)).toBe(true);
  });

  it("derives resource readiness from published executable versions, independently of draft and latest test", async () => {
    const { guardrail, run, version } = await releasedFixture();
    const summary = () => service.getGuardrail(guardrail.id);
    expect(await summary()).toMatchObject({ readiness: "ready", versionSummary: { total: 1, released: 1, pending: 0, missingEvidence: 0 } });
    await versionReport(guardrail.id, version.version, "failed");
    await database.pool.query("UPDATE guardrail SET draft_revision=draft_revision+1, draft_config=jsonb_set(draft_config, '{allowedTopics}', $2::jsonb) WHERE id=$1", [guardrail.id, JSON.stringify(["Changed business scope"])]);
    expect(await summary()).toMatchObject({ readiness: "ready", hasUnpublishedChanges: true });
    // Test evidence does not grant or revoke publication.
    await database.pool.query("UPDATE guardrail_validation_run SET test_suite_digest='wrong' WHERE id=$1", [run.id]);
    expect(await summary()).toMatchObject({ status: "active", readiness: "ready", versionSummary: { total: 1, released: 1, missingEvidence: 0 } });
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
    await database.pool.query("UPDATE guardrail_version SET status='pending', released_at=NULL, released_by=NULL WHERE guardrail_id=$1", [guardrail.id]);
    await versionReport(guardrail.id, version.version);
    expect(await service.getGuardrail(guardrail.id)).toMatchObject({ readiness: "not_ready", versionSummary: { total: 1, pending: 1 } });
    await service.releaseGuardrailVersion({ guardrailId: guardrail.id, version: version.version, actorId: "admin" });
    expect(await service.getGuardrail(guardrail.id)).toMatchObject({ readiness: "ready", versionSummary: { total: 1, released: 1 } });
  });

  it("keeps registry report summaries separate from draft testing and clears deleted report references", async () => {
    const { guardrail, run, version } = await releasedFixture();
    const second = await versionReport(guardrail.id, version.version);
    expect(await service.getGuardrail(guardrail.id)).toMatchObject({ latestTestingReport: { id: second.id, subject: "version" }, latestValidationRun: { id: run.id, subject: "draft" } });
    expect(await service.testingReportDeletionImpact(run.id)).toMatchObject({ deletable: true, pendingVersion: null, replacementRunId: null });
    await service.deleteTestingReport({ runId: run.id, actorId: "admin", expectedPendingVersion: null });
    await expect(service.getValidationRun(run.id)).rejects.toMatchObject({ status: 404 });
    expect((await database.pool.query("SELECT status, validation_run_id FROM guardrail_version WHERE guardrail_id=$1", [guardrail.id])).rows).toEqual([{ status: "ready", validation_run_id: null }]);
    expect((await database.pool.query("SELECT id FROM controller_outbox WHERE id=$1", [run.id])).rows).toEqual([]);
    expect(await service.getGuardrail(guardrail.id)).toMatchObject({ latestTestingReport: { id: second.id }, latestValidationRun: null, hasUnpublishedChanges: false });
    const failed = await versionReport(guardrail.id, version.version, "failed");
    await service.deleteTestingReport({ runId: failed.id, actorId: "admin", expectedPendingVersion: null });
    expect(await service.getGuardrail(guardrail.id)).toMatchObject({ latestTestingReport: { id: second.id } });
  });

  it("preserves publication and frozen content when its last report is deleted", async () => {
    const { guardrail, run, version } = await releasedFixture();
    const before = (await database.pool.query("SELECT artifact_id, plan, test_suite, inspection FROM guardrail_version WHERE guardrail_id=$1", [guardrail.id])).rows;
    expect(await service.testingReportDeletionImpact(run.id)).toMatchObject({ deletable: true, pendingVersion: null });
    await service.deleteTestingReport({ runId: run.id, actorId: "admin", expectedPendingVersion: null });
    expect((await database.pool.query("SELECT status, validation_run_id, released_at, released_by FROM guardrail_version WHERE guardrail_id=$1", [guardrail.id])).rows).toEqual([{ status: "ready", validation_run_id: null, released_at: expect.any(Date), released_by: "admin" }]);
    expect((await database.pool.query("SELECT artifact_id, plan, test_suite, inspection FROM guardrail_version WHERE guardrail_id=$1", [guardrail.id])).rows).toEqual(before);
    expect(await service.getGuardrail(guardrail.id)).toMatchObject({ status: "active", latestTestingReport: null });
    const audit = (await database.pool.query("SELECT detail FROM audit_event WHERE resource_id=$1 AND kind='guardrail.testing_report_deleted'", [guardrail.id])).rows[0];
    expect(audit.detail).toMatchObject({ runId: run.id, pendingVersion: null });
    await expect(service.releaseGuardrailVersion({ guardrailId: guardrail.id, version: version.version, actorId: "admin" })).resolves.toMatchObject({ status: "ready" });
    await service.completeValidation({ runId: run.id, status: "passed", metrics: emptyValidationMetrics(0), results: [] });
    expect((await service.listValidationRuns(guardrail.id))).toEqual([]);
    const newReport = await versionReport(guardrail.id, version.version);
    expect(await service.releaseGuardrailVersion({ guardrailId: guardrail.id, version: version.version, actorId: "admin" })).toMatchObject({ status: "ready", validationRunId: null });
  });

  it("keeps publication independent of mismatched historical test evidence", async () => {
    const { guardrail, run, version } = await releasedFixture();
    const wrong = await versionReport(guardrail.id, version.version);
    await database.pool.query("UPDATE guardrail_validation_run SET test_suite_digest='wrong-suite' WHERE id=$1", [wrong.id]);
    expect(await service.testingReportDeletionImpact(run.id)).toMatchObject({ pendingVersion: null, replacementRunId: null });
    await database.pool.query("UPDATE guardrail_validation_run SET test_suite_digest=$2, candidate_digest='wrong-content' WHERE id=$1", [wrong.id, run.testSuiteDigest]);
    expect(await service.testingReportDeletionImpact(run.id)).toMatchObject({ pendingVersion: null, replacementRunId: null });
  });

  it("allows deleting routed versions' completed reports and rejects running report deletion", async () => {
    const { guardrail, run, version } = await releasedFixture();
    await service.trafficRouting.create("Evidence protection", "", { routes: [{ id: "fallback", name: "Fallback", kind: "fallback", enabled: true,
      selector: { expression: { combinator: "and", conditions: [] } }, targets: [{ id: "target", guardrailId: guardrail.id, guardrailVersion: version.version, weightBps: 10000 }] }] }, "admin");
    expect(await service.testingReportDeletionImpact(run.id)).toMatchObject({ deletable: true, pendingVersion: null, references: [] });
    const running = await service.requestVersionTestRun({ guardrailId: guardrail.id, version: version.version, actorId: "admin" });
    expect(await service.testingReportDeletionImpact(running.id)).toMatchObject({ running: true, deletable: false });
    await expect(service.deleteTestingReport({ runId: running.id, actorId: "admin", expectedPendingVersion: null })).rejects.toMatchObject({ code: "test_report_in_use" });
    await service.completeValidation({ runId: running.id, status: "passed", metrics: emptyValidationMetrics(running.metrics.total), results: [] });
    // References do not block deleting redundant evidence.
    await service.deleteTestingReport({ runId: run.id, actorId: "admin", expectedPendingVersion: null });
  });

  it("serializes concurrent report deletions without changing publication", async () => {
    const { guardrail, run, version } = await releasedFixture();
    const second = await versionReport(guardrail.id, version.version);
    const result = await Promise.allSettled([run.id, second.id].map(runId => service.deleteTestingReport({ runId, actorId: "admin", expectedPendingVersion: null })));
    expect(result.filter(item => item.status === "fulfilled")).toHaveLength(2);
    expect(await service.listValidationRuns(guardrail.id)).toHaveLength(0);
    expect((await database.pool.query("SELECT status FROM guardrail_version WHERE guardrail_id=$1", [guardrail.id])).rows).toEqual([{ status: "ready" }]);
  });

  it("applies operating modes only after all Runner ACKs, with concurrency and readiness checks", async () => {
    const { guardrail, version } = await releasedFixture();
    await database.pool.query("INSERT INTO runner_pool (id, name) VALUES ('mode-test', 'Mode test')");
    await database.pool.query(`INSERT INTO runner_instance (runner_id, boot_id, pool_id, status, runner_version, nemo_version, max_concurrency, labels)
      SELECT name, 'boot-' || name, 'mode-test', 'ready', 'test', 'test', 4, '{"tasklattice.protection-modes":"1"}'::jsonb FROM unnest(ARRAY['mode-a', 'mode-b']) AS name`);
    try {
      const artifactsBefore = (await database.pool.query("SELECT * FROM guardrail_artifact WHERE guardrail_id=$1", [guardrail.id])).rows;
      const versionsBefore = (await database.pool.query("SELECT * FROM guardrail_version WHERE guardrail_id=$1", [guardrail.id])).rows;
      const update = (mode: "enforce" | "monitor" | "bypass", expectedGeneration = 0) => service.protectionModes.update({ id: guardrail.id, mode, expectedGeneration, reason: "upstream incident", actorId: "admin" });
      const changed = await update("bypass");
      expect(changed).toMatchObject({ mode: "bypass", appliedMode: "enforce", status: "applying", applied: 0, total: 2, updatedBy: "Admin" });
      await expect(update("monitor")).rejects.toMatchObject({ code: "protection_mode_conflict" });
      const ack = (runnerId: string, accepted = true, generation = changed.generation, bootId = `boot-${runnerId}`) => service.protectionModes.recordResult({ runnerId, bootId, generation, accepted, reason: "disk failure" });
      await ack("mode-a", true, changed.generation, "stale-boot");
      expect((await service.protectionModes.get(guardrail.id)).applied).toBe(0);
      await ack("mode-a");
      await ack("mode-b", false);
      expect(await service.protectionModes.get(guardrail.id)).toMatchObject({ status: "partial", applied: 1, appliedMode: "enforce", runners: [{ status: "applied" }, { status: "failed" }] });
      await ack("mode-b", true, changed.generation - 1);
      expect((await service.protectionModes.get(guardrail.id)).applied).toBe(1);
      await ack("mode-b");
      expect(await service.protectionModes.get(guardrail.id)).toMatchObject({ status: "applied", appliedMode: "bypass", applied: 2 });
      expect((await service.protectionModes.desiredState()).modes[guardrail.id]).toBe("bypass");
      expect((await database.pool.query("SELECT * FROM guardrail_artifact WHERE guardrail_id=$1", [guardrail.id])).rows).toEqual(artifactsBefore);
      expect((await database.pool.query("SELECT * FROM guardrail_version WHERE guardrail_id=$1", [guardrail.id])).rows).toEqual(versionsBefore);
      // A new version test still queues the signed Artifact and frozen real cases.
      const report = await versionReport(guardrail.id, version.version);
      expect(report.subject).toBe("version");
      expect((await service.protectionModes.get(guardrail.id)).mode).toBe("bypass");
      expect(JSON.stringify(parsePackage((await service.packages.exportPackage(guardrail.id, [version.version])).bytes).manifest)).not.toContain("protectionMode");
      const history = (await database.pool.query("SELECT detail FROM audit_event WHERE resource_id=$1 AND kind='guardrail.protection_mode_changed'", [guardrail.id])).rows;
      expect(history).toEqual([{ detail: { previousMode: "enforce", mode: "bypass", reason: "upstream incident", generation: changed.generation } }]);
      await update("monitor", changed.generation);
      await service.deleteGuardrailVersion({ guardrailId: guardrail.id, version: version.version, actorId: "admin" });
      const reset = await service.protectionModes.get(guardrail.id);
      expect(reset).toMatchObject({ ready: false, mode: "enforce", appliedMode: "enforce" });
      expect(reset.generation).toBeGreaterThan(changed.generation);
      expect((await service.protectionModes.desiredState()).modes[guardrail.id]).toBeUndefined();
      await expect(update("bypass", reset.generation)).rejects.toMatchObject({ code: "guardrail_not_ready" });
    } finally {
      await database.pool.query("DELETE FROM runner_instance WHERE pool_id='mode-test'");
      await database.pool.query("DELETE FROM runner_pool WHERE id='mode-test'");
    }
  });

  it("preserves modes across publication and report deletion until the last version is deleted", async () => {
    const { guardrail, version } = await releasedFixture();
    await service.protectionModes.update({ id: guardrail.id, mode: "monitor", expectedGeneration: 0, reason: "observe", actorId: "admin" });
    await database.pool.query("UPDATE guardrail SET draft_revision=draft_revision+1 WHERE id=$1", [guardrail.id]);
    const run = await service.requestValidation({ guardrailId: guardrail.id, actorId: "admin", compilerAvailable: true });
    await expect(service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "admin" })).rejects.toMatchObject({ code: "guardrail_compiler_unavailable" });
    await service.completeValidation({ runId: run.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [], candidateArtifact: await runnerCandidate(run.id) });
    await service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "admin" });
    expect((await service.protectionModes.get(guardrail.id)).mode).toBe("monitor");
    await service.deleteGuardrailVersion({ guardrailId: guardrail.id, version: version.version, actorId: "admin" });
    expect((await service.protectionModes.get(guardrail.id)).mode).toBe("monitor");
    await service.deleteTestingReport({ runId: run.id, actorId: "admin", expectedPendingVersion: null });
    expect(await service.protectionModes.get(guardrail.id)).toMatchObject({ ready: true, mode: "monitor" });
    await service.deleteGuardrailVersion({ guardrailId: guardrail.id, version: run.guardrailVersion, actorId: "admin" });
    expect(await service.protectionModes.get(guardrail.id)).toMatchObject({ ready: false, mode: "enforce" });
  });

  function compile(input: ArtifactCompilation): ArtifactContent {
    return { ...input, compilerVersion: "offline-test", nemoVersion: "0.24.0",
      runtimeProfile: "llmrails_colang1_standard", configYaml: "models: []\n", colangContent: "",
      prompts: [], actionBindings: [], dependencyManifest: [] };
  }

  it.each(["untested", "queued", "failed"])("publishes a full-feature Profile while tests are %s without model assignments", async status => {
    const draft = profileDraft(fullFeatureBaseline, await service.listPolicies());
    const guardrail = await service.createGuardrail({ name: `Profile ${status}`, draftConfig: draft, runtimeProfile: "auto", actorId: "admin" });
    const compiler = vi.fn(async (input: ArtifactCompilation) => compile(input));
    service.setArtifactCompiler(compiler);
    const run = status === "untested" ? null : await service.requestValidation({ guardrailId: guardrail.id, actorId: "admin", compilerAvailable: true });
    if (run && status === "failed") await service.completeValidation({ runId: run.id, status: "failed", metrics: emptyValidationMetrics(run.metrics.total),
      results: [{ caseId: "strict-evidence", name: "Target Rule did not execute", policyId: "target", phase: "input",
        expectedDecision: "block", actualDecision: "block", passed: false, action: "block", reason: "Another Rule cannot prove target acceptance.",
        evaluatorIds: [], findings: [], trace: [], latencyMs: 1, coveredRuleIds: ["target-rule"], matchedRuleIds: [],
        evidenceStatus: "preempted_by", evidenceDetail: "Target not reached", verifiedRuleIds: [],
        supersededBy: [{ policyId: "blocker", ruleId: "blocker-rule" }], ruleContractSatisfied: false, evidenceContract: "rule-evidence-v1" }],
      candidateArtifact: await runnerCandidate(run.id) });
    const published = await service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "admin", expectedDraftRevision: 1 });
    expect(published.status).toBe("ready");
    expect(compiler).toHaveBeenCalledTimes(status === "failed" ? 0 : 1);
    expect(await service.getGuardrail(guardrail.id)).toMatchObject({ readiness: "ready" });
    if (run) {
      expect(await service.getValidationRun(run.id)).toMatchObject({ status });
      if (status === "failed") {
        expect((await service.getValidationRun(run.id)).results[0]).toMatchObject({ passed: false, evidenceStatus: "preempted_by", ruleContractSatisfied: false });
        await versionReport(guardrail.id, published.version, "failed");
        const archived = (await service.getGuardrail(guardrail.id)).versions[0]!;
        expect(archived).toMatchObject({ status: "ready", testingEvidence: { release: { id: run.id, status: "failed" } } });
      }
    }
    else expect(await service.listValidationRuns(guardrail.id)).toEqual([]);
    const record = (await database.pool.query("SELECT publication FROM guardrail_version WHERE guardrail_id=$1", [guardrail.id])).rows[0];
    expect(record.publication).toMatchObject({ source: "user", actorId: "admin" });
  });

  it("publishes an empty test suite and serializes simultaneous compilation results", async () => {
    const guardrail = await service.createGuardrail({ name: "No tests", draftConfig: defaultGuardrailDraft(PolicyCatalog.load(catalogDir).list()), runtimeProfile: "auto", actorId: "admin" });
    await database.pool.query("UPDATE guardrail SET excluded_test_case_ids=(SELECT jsonb_agg(id) FROM guardrail_test_case WHERE guardrail_id=$1) WHERE id=$1", [guardrail.id]);
    let enter!: () => void;
    let resume!: () => void;
    const both = new Promise<void>(resolve => { enter = resolve; });
    const ready = new Promise<void>(resolve => { resume = resolve; });
    let count = 0;
    service.setArtifactCompiler(async input => { if (++count === 2) enter(); await ready; return compile(input); });
    const results = Promise.all([1, 2].map(() => service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "admin" })));
    await both; resume();
    const versions = await results;
    expect(versions[0]!.version).toBe(versions[1]!.version);
    expect((await service.getGuardrail(guardrail.id)).versions).toHaveLength(1);
    expect((await service.guardrailVersionTestSuite(guardrail.id, versions[0]!.version)).items).toEqual([]);
  });

  it("preserves the online release after compile failure and rejects a draft edited during compilation", async () => {
    const { guardrail, version } = await releasedFixture();
    await database.pool.query("UPDATE guardrail SET draft_revision=draft_revision+1 WHERE id=$1", [guardrail.id]);
    const before = (await database.pool.query("SELECT desired_generation FROM controller_state")).rows;
    service.setArtifactCompiler(async () => { throw new Error("Invalid flow"); });
    await expect(service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "admin" })).rejects.toThrow("Invalid flow");
    expect((await database.pool.query("SELECT desired_generation FROM controller_state")).rows).toEqual(before);
    expect((await service.getGuardrail(guardrail.id)).versions.map(v => v.version)).toEqual([version.version]);
    service.setArtifactCompiler(async input => {
      await database.pool.query("UPDATE guardrail SET draft_revision=draft_revision+1 WHERE id=$1", [guardrail.id]);
      return compile(input);
    });
    await expect(service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "admin" })).rejects.toMatchObject({ code: "guardrail_draft_conflict" });
    expect((await database.pool.query("SELECT desired_generation FROM controller_state")).rows).toEqual(before);
    service.setArtifactCompiler(async input => compile(input));
    await expect(service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "admin" })).resolves.toMatchObject({ status: "ready" });
    expect((await service.getGuardrail(guardrail.id)).versions).toHaveLength(2);
  });

  it("retries Profile creation with one identity and rejects a changed idempotency payload", async () => {
    const input = { name: "Retry creation", draftConfig: profileDraft(fullFeatureBaseline, await service.listPolicies()), runtimeProfile: "auto", actorId: "admin", idempotencyKey: "same-creation" };
    const [first, second] = await Promise.all([service.createGuardrail(input), service.createGuardrail(input)]);
    expect(first.id).toBe(second.id);
    await expect(service.createGuardrail({ ...input, name: "Different" })).rejects.toMatchObject({ status: 409 });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM guardrail WHERE creation_key IS NOT NULL")).rows[0].n).toBe(1);
  });

  it("keeps missing-model publications out of unrelated rollout and admits them independently", async () => {
    const { guardrail, version } = await releasedFixture();
    expect((await service.desiredStateForPool("default")).artifacts.some(a => a.guardrailId === guardrail.id)).toBe(false);
    service.setArtifactAdmission(async () => [{ poolId: "default", runnerId: "runner", admitted: false, unavailable: false, reason: "Missing model", nemoVersion: "0.24.0", modelRevisionId: "" }]);
    await service.packages.checkVersionEnvironment(guardrail.id, version.version);
    expect((await service.getGuardrail(guardrail.id)).versions[0]).toMatchObject({ status: "ready", environmentCheck: { status: "missing" } });
    expect((await service.desiredStateForPool("default")).artifacts.some(a => a.guardrailId === guardrail.id)).toBe(false);
    service.setArtifactAdmission(async () => [{ poolId: "default", runnerId: "runner", admitted: true, unavailable: false, reason: "", nemoVersion: "0.24.0", modelRevisionId: "" }]);
    await service.packages.checkVersionEnvironment(guardrail.id, version.version);
    expect((await service.desiredStateForPool("default")).artifacts.some(a => a.guardrailId === guardrail.id)).toBe(true);
    expect((await service.getGuardrail(guardrail.id)).versions[0]).toMatchObject({ status: "ready", environmentCheck: { status: "compatible" } });
  });

});
