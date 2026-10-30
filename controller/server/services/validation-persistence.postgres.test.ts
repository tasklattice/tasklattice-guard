import { completeReport } from "../db/report-test-utils.js";
// @vitest-environment node
import { resolve } from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { defaultGuardrailDraft } from "../domain/defaults.js";
import { emptyValidationMetrics } from "../domain/validation.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { ControlPlaneService } from "./control-plane.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Test report persistence under connection pressure", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  let guardrailId: string;
  let lines: Array<Record<string, any>>;
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "info").mockImplementation(line => { lines.push(JSON.parse(line)); });
    vi.spyOn(console, "error").mockImplementation(line => { lines.push(JSON.parse(line)); });
  });
  afterEach(() => vi.restoreAllMocks());
  beforeAll(async () => {
    database = await createTestDatabase(url!, "validation_persistence");
    // A nested acquisition would now fail instead of hiding in a large pool.
    database.pool.options.max = 1;
    database.pool.options.connectionTimeoutMillis = 200;
    const catalogDir = resolve("../runner/toolkit/policy_library/assets");
    service = new ControlPlaneService(database.db, loadConfig({
      NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!, CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
      CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem", CONTROLLER_POLICY_CATALOG_DIR: catalogDir,
      CONTROLLER_PROTO_PATH: resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"),
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
    }));
    await database.pool.query("INSERT INTO auth_user (id, name, email, role) VALUES ('admin', 'Admin', 'admin@example.test', 'admin')");
    await database.pool.query("INSERT INTO controller_state (id, desired_generation) VALUES ('singleton', 1)");
    const guardrail = await service.createGuardrail({ name: "Persistence fixture", actorId: "admin", runtimeProfile: "auto",
      draftConfig: defaultGuardrailDraft(PolicyCatalog.load(catalogDir).list()) });
    guardrailId = guardrail.id;
  });
  afterAll(async () => { await service?.stopReportWork(); await database?.drop(); });

  async function prepareReport() {
    const run = await service.requestValidation({ guardrailId, actorId: "admin", compilerAvailable: true });
    await service.markValidationRunning(run.id);
    await service.updateValidationProgress(run.id, { phase: "finalizing", completedCases: run.metrics.total, passedCases: run.metrics.total });
    const { rows: [request] } = await database.pool.query("SELECT payload FROM controller_outbox WHERE id = $1", [run.id]);
    return {
      runId: run.id, status: "passed" as const, metrics: emptyValidationMetrics(run.metrics.total), results: [],
      candidateArtifact: { guardrailId, guardrailVersion: request.payload.candidateVersion,
        compilerVersion: "tasklattice-nemo-config-v29-single-contract", nemoVersion: "0.24.0", runtimeProfile: "llmrails_colang1_standard",
        plan: request.payload.plan, configYaml: "models: []\n", colangContent: "", prompts: [], actionBindings: [], dependencyManifest: [] },
    };
  }

  it("saves and prunes complete draft reports repeatedly with only one connection", async () => {
    for (let i = 0; i < 5; i++) {
      const result = await prepareReport();
      await completeReport(service, result);
      await completeReport(service, result); // Terminal delivery is idempotent.
      await service.drainReportWork();
      expect(database.pool.idleCount).toBe(1);
      expect(database.pool.waitingCount).toBe(0);
      const { rows: [run] } = await database.pool.query("SELECT status, candidate_digest FROM guardrail_validation_run WHERE id = $1", [result.runId]);
      expect(run.status).toBe("passed");
      expect(run.candidate_digest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect((await database.pool.query("SELECT count(*)::int AS n FROM guardrail_validation_run WHERE guardrail_id = $1", [guardrailId])).rows[0].n).toBe(2);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM controller_outbox WHERE aggregate_id = $1 AND processed_at IS NULL", [guardrailId])).rows[0].n).toBe(0);
    const completed = lines.filter(line => line.status === "succeeded").map(line => line.stage);
    expect(completed).toEqual(expect.arrayContaining(["pool_acquire", "begin", "set_timeouts", "lock_guardrail", "lock_run",
      "load_candidate_request", "normalize_candidate", "digest_candidate", "validate_scope", "write_report", "complete_outbox", "write_audit", "commit", "pool_release", "save"]));
    expect(lines.filter(line => line.stage === "save" && line.status === "started")).toHaveLength(10);
  });

  it("bounds a report's lock wait, rolls back cleanly, and saves the same result after contention clears", async () => {
    const report = await prepareReport();
    const blocker = new Client({ connectionString: url!, options: database.pool.options.options });
    await blocker.connect();
    let completed: Promise<void> | undefined;
    let failure: unknown;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM guardrail WHERE id = $1 FOR UPDATE", [guardrailId]);
      completed = completeReport(service, report).catch(error => { failure = error; });
      await vi.waitFor(async () => {
        const { rows } = await blocker.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [database.pool.options.application_name]);
        expect(rows[0].n).toBe(1);
      });
      // Waiting for a row lock holds the pool slot and can starve unrelated
      // control-plane reads, producing exactly the timeout from the trace.
      await expect(service.desiredGeneration()).rejects.toMatchObject({ cause: { message: "timeout exceeded when trying to connect" } });
      await vi.waitFor(() => expect(failure).toMatchObject({ cause: { code: "55P03" } }), { timeout: 3_500 });
      expect(lines).toContainEqual(expect.objectContaining({ runId: report.runId, stage: "lock_guardrail", status: "failed",
        error: { category: "lock_unavailable", code: "55P03", sqlState: "55P03" }, pool: expect.objectContaining({ busy: 1, idle: 0 }) }));
      expect(lines).toContainEqual(expect.objectContaining({ stage: "rollback", status: "succeeded" }));
      expect(database.pool.idleCount).toBe(1);
      expect(await service.desiredGeneration()).toBe(1);
      expect((await database.pool.query("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle")).rows[0])
        .toEqual({ lock: "0", statement: "0", idle: "0" });
      const { rows: [run] } = await database.pool.query("SELECT status, progress->>'phase' AS phase FROM guardrail_validation_run WHERE id = $1", [report.runId]);
      expect(run).toEqual({ status: "running", phase: "finalizing" });
      expect((await database.pool.query("SELECT processed_at FROM controller_outbox WHERE id = $1", [report.runId])).rows[0].processed_at).toBeNull();
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
      await completed;
    }
    await completeReport(service, report);
    expect((await database.pool.query("SELECT status FROM guardrail_validation_run WHERE id = $1", [report.runId])).rows[0].status).toBe("passed");
    expect(database.pool.waitingCount).toBe(0);
  }, 10_000);

  it("redacts report values and PostgreSQL error detail when writing the report fails", async () => {
    const report = await prepareReport();
    const secret = "PRIVATE_REPORT_CREDENTIAL_SENTINEL";
    report.candidateArtifact.configYaml += `# ${secret}\n`;
    await database.pool.query(`CREATE FUNCTION reject_report_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'PRIVATE_REPORT_CREDENTIAL_SENTINEL' USING ERRCODE = '23514', DETAIL = 'PRIVATE_REPORT_CREDENTIAL_SENTINEL'; END $$`);
    await database.pool.query(`CREATE TRIGGER reject_report_write BEFORE UPDATE OF status ON guardrail_validation_run
      FOR EACH ROW WHEN (NEW.status = 'passed') EXECUTE FUNCTION reject_report_write()`);
    try {
      await expect(completeReport(service, { ...report, reason: secret })).rejects.toMatchObject({ cause: { code: "23514" } });
      expect(lines).toContainEqual(expect.objectContaining({ stage: "write_report", status: "failed",
        error: { category: "database_error", code: "23514", sqlState: "23514" } }));
      expect(lines).toContainEqual(expect.objectContaining({ stage: "rollback", status: "succeeded" }));
      expect(JSON.stringify(lines)).not.toContain(secret);
      expect(database.pool.idleCount).toBe(1);
    } finally {
      await database.pool.query("DROP TRIGGER reject_report_write ON guardrail_validation_run");
      await database.pool.query("DROP FUNCTION reject_report_write()");
    }
    await completeReport(service, report);
    const attempts = lines.filter(line => line.stage === "save" && line.status === "started");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.attemptId).not.toBe(attempts[1]!.attemptId);
  });
});
