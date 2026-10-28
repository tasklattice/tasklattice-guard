// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createHttpApp } from "../http/app.js";
import { loadConfig } from "../config.js";
import type { ControllerAuth } from "../auth.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import type { ControllerConfig } from "../config.js";
import { ControlPlaneService } from "./control-plane.js";
import { emptyValidationMetrics } from "../domain/validation.js";
import { defaultGuardrailDraft } from "../domain/defaults.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("durable test cancellation", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "test_cancel");
    service = new ControlPlaneService(database.db, {} as ControllerConfig);
    await database.pool.query(`INSERT INTO auth_user (id, name, email) VALUES ('actor', 'Tester', 'tester@example.test')`);
  });
  afterAll(async () => { await database?.drop(); });

  async function fixture(id: string, status: string) {
    await database.pool.query(`INSERT INTO guardrail (id, name, draft_config) VALUES ($1, 'Cancellation fixture', '{}')`, [id]);
    await database.pool.query(`INSERT INTO guardrail_validation_run
      (id, guardrail_id, guardrail_version, source_draft_revision, status) VALUES ($1, $1, 'v1', 1, $2)`, [id, status]);
    await database.pool.query(`INSERT INTO controller_outbox (id, kind, aggregate_id, payload)
      VALUES ($1, 'guardrail.validation_requested', $1, jsonb_build_object('runId', $1::text))`, [id]);
  }

  it.each(["queued", "running"])("cancels %s once, keeps the report, and rejects late progress/results", async status => {
    const id = `run-${status}`;
    await fixture(id, status);
    const cancelled = await service.cancelValidation({ runId: id, actorId: "actor" });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.completedAt).toBeInstanceOf(Date);
    await service.cancelValidation({ runId: id, actorId: "actor" });
    expect(await service.markValidationRunning(id)).toBe(false);
    await service.updateValidationProgress(id, { phase: "executing", completedCases: 1, passedCases: 1 });
    await service.completeValidation({ runId: id, status: "passed", metrics: emptyValidationMetrics(1), results: [] });
    const { rows: [run] } = await database.pool.query("SELECT * FROM guardrail_validation_run WHERE id=$1", [id]);
    expect(run.status).toBe("cancelled");
    expect(run.progress).toBeNull();
    const { rows: events } = await database.pool.query("SELECT * FROM controller_outbox WHERE aggregate_id=$1 ORDER BY id", [id]);
    expect(events).toHaveLength(2);
    expect(events.find(item => item.id === id).processed_at).not.toBeNull();
    expect(events.find(item => item.id === `cancel-${id}`)).toMatchObject({ processed_at: null, payload: { runId: id } });
    const { rows: [audit] } = await database.pool.query("SELECT count(*)::int AS total FROM audit_event WHERE resource_id=$1 AND kind='guardrail.validation_cancelled'", [id]);
    expect(audit.total).toBe(1);
  });

  it("GuardCtl reads and cancels a real persisted task through the production HTTP routes", async () => {
    await fixture("cli-run", "running");
    const catalogDir = resolve("../runner/toolkit/policy_library/assets");
    const draft = defaultGuardrailDraft(PolicyCatalog.load(catalogDir).list());
    draft.policyBindings = draft.policyBindings.slice(0, 1).map(binding => ({ ...binding, testCaseOverrides: {} }));
    await database.pool.query("UPDATE guardrail SET draft_config=$1 WHERE id='cli-run'", [JSON.stringify(draft)]);
    await database.pool.query(`INSERT INTO guardrail_test_case
      (id, guardrail_id, name, policy_id, phase, content, expected_decision, origin)
      VALUES ('case-cli', 'cli-run', 'CLI lifecycle', '', 'input', 'hello', 'allow', 'custom')`);
    const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
      CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem", CONTROLLER_POLICY_CATALOG_DIR: catalogDir,
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
    const app = createHttpApp({ config, service: new ControlPlaneService(database.db, config),
      auth: { handler: async () => Response.json({}, { headers: { "set-cookie": "test-session=fixture; HttpOnly; Path=/" } }),
        api: { getSession: async ({ headers }: { headers: Headers }) => headers.get("cookie") === "test-session=fixture"
          ? { user: { id: "actor", role: "user" } } : null } } as unknown as ControllerAuth,
      runnerControl: { hasDefaultCompiler: () => true } as RunnerControlServer, metrics: {} as ControllerMetrics });
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener");
    const base = `http://127.0.0.1:${address.port}`;
    const cli = async (command: string, flags = ["--run-id", "cli-run"]) => {
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", resolve("src/cli/guardctl.ts"),
        "tenant", command, ...flags, `--url=${base}`], { timeout: 15_000,
        env: { ...process.env, GUARD_TENANT_TOKEN: "", GUARD_TENANT_USERNAME: "test-user", GUARD_TENANT_PASSWORD: "test-only" } });
      return JSON.parse(stdout.trim());
    };
    try {
      const submitted = await cli("test", ["--guardrail-id", "cli-run", "--local-only"]);
      expect(submitted).toMatchObject({ status: "queued", testModelRules: false });
      expect(submitted.id).toMatch(/^testing-report-/);
      expect(await cli("test-cancel", ["--run-id", submitted.id])).toMatchObject({ id: submitted.id, status: "cancelled" });
      expect(await service.markValidationRunning(submitted.id)).toBe(false);
      expect(await cli("test-status")).toMatchObject({ id: "cli-run", status: "running" });
      expect(await cli("test-cancel")).toMatchObject({ id: "cli-run", status: "cancelled" });
      expect(await cli("test-status")).toMatchObject({ id: "cli-run", status: "cancelled", cancellation: { acknowledgedAt: null } });
      expect(await cli("test-cancel")).toMatchObject({ id: "cli-run", status: "cancelled" });
      const { rows } = await database.pool.query("SELECT * FROM controller_outbox WHERE id='cancel-cli-run'");
      expect(rows).toHaveLength(1);
      expect(rows[0].processed_at).toBeNull();
      await service.markOutboxProcessed("cancel-cli-run");
      const confirmed = await cli("test-status");
      expect(confirmed.cancellation.acknowledgedAt).toEqual(expect.any(String));
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 30_000);

  it.each(["passed", "failed"])("does not rewrite an already %s report", async status => {
    const id = `run-${status}`;
    await fixture(id, status);
    expect((await service.cancelValidation({ runId: id, actorId: "actor" })).status).toBe(status);
    const { rows } = await database.pool.query("SELECT id FROM controller_outbox WHERE id=$1", [`cancel-${id}`]);
    expect(rows).toHaveLength(0);
  });
});
