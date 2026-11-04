// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Registry } from "prom-client";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { loadConfig } from "../config.js";
import type { ControllerAuth } from "../auth.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
const legacy = "legacy-runner-token-at-least-32-characters";
const poolA = "runner-pool-a-token-at-least-32-characters";
const poolB = "runner-pool-b-token-at-least-32-characters";
const env = { NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://unused:unused@localhost/unused",
  CONTROLLER_RUNNER_TOKEN: legacy, CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ "pool-a": poolA, "pool-b": poolB }),
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem", BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" };

describe.skipIf(!url)("pool-scoped telemetry HTTP", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "scoped_telemetry");
    service = new ControlPlaneService(database.db, loadConfig(env));
    await database.pool.query(`INSERT INTO guardrail (id,project_id,name,draft_config) VALUES ('shared','projectC','Shared','{}');
      INSERT INTO endpoint (id,project_id,name,adapter) VALUES ('endpoint-a','projectA','A','litellm-generic-guardrail');`);
    await service.registerPlaygroundInvocation({ callId: "playground:a", projectId: "projectA", guardrailId: "shared", guardrailVersion: "20260912-083000.123Z", poolId: "pool-a", groupId: "group-a" });
    await service.registerPlaygroundInvocation({ callId: "playground:b", projectId: "projectB", guardrailId: "shared", guardrailVersion: "20260912-083000.123Z", poolId: "pool-b", groupId: "group-b" });
    await database.pool.query("INSERT INTO playground_invocation (call_id,project_id,guardrail_id,guardrail_version,expires_at) VALUES ('playground:old','projectC','shared','20260912-083000.123Z',now() + interval '1 hour')");
  }, 30000);
  afterAll(async () => { await database?.drop(); });
  const app = (scoped: boolean) => createHttpApp({ config: loadConfig({ ...env, CONTROLLER_RUNNER_SCOPED_TELEMETRY: String(scoped) }),
    auth: { api: { getSession: vi.fn() } } as unknown as ControllerAuth, service,
    runnerControl: {} as RunnerControlServer, metrics: { registry: new Registry() } as ControllerMetrics });
  const post = (target: ReturnType<typeof app>, token: string, events: unknown[], runnerId?: string) => target.request("/api/internal/v1/runtime-events", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ events, runnerId }),
  });
  const event = (id: string, requestId: string, overrides: Record<string, unknown> = {}) => ({
    id, requestId, occurredAt: new Date().toISOString(), runnerId: "claimed-runner", guardrailId: "shared", guardrailVersion: "20260912-083000.123Z",
    direction: "incoming", decision: "allow", durationMs: 1, metadata: { protocol: "playground", usage: { model_calls: [{ call_id: "model-call", provider: "synthetic", model: "synthetic", usage_known: true, input_tokens: 1, output_tokens: 1 }] } }, ...overrides,
  });
  it("rejects legacy credentials and quarantines mixed unauthorized and unsupported origins", async () => {
    const scoped = app(true);
    expect((await post(scoped, legacy, [])).status).toBe(401);
    expect((await post(scoped, "unknown", [])).status).toBe(401);
    const now = new Date().toISOString();
    const routing = { id: "r1", eventType: "route_assignment", decisionId: "d1", callId: "c1", runnerId: "claimed-runner", endpointId: "endpoint-a",
      routerId: "", routerRevision: 0, routeId: "", targetId: "", guardrailId: "", guardrailVersion: "", occurredAt: now, decisionAt: now, assignmentStatus: "unassigned" };
    const response = await post(scoped, poolA, [event("own", "playground:a"), event("foreign", "playground:b"), event("old", "playground:old"),
      event("endpoint", "external", { endpointId: "endpoint-a", metadata: { protocol: "litellm" } }), routing], "spoofed-runner");
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 5 });
    expect((await database.pool.query("SELECT id, project_id FROM runtime_event ORDER BY id")).rows).toEqual([
      { id: "endpoint", project_id: null }, { id: "foreign", project_id: null }, { id: "old", project_id: null }, { id: "own", project_id: "projectA" },
    ]);
    expect((await database.pool.query("SELECT event_id, project_id FROM model_usage_cost ORDER BY event_id")).rows).toEqual([
      { event_id: "foreign", project_id: null }, { event_id: "old", project_id: null }, { event_id: "own", project_id: "projectA" },
    ]);
    expect((await database.pool.query("SELECT project_id FROM route_assignment WHERE decision_id='d1'")).rows).toEqual([{ project_id: null }]);
    expect((await database.pool.query("SELECT runner_id FROM telemetry_watermark")).rows).toEqual([]);
    expect((await post(scoped, poolB, [], "spoofed-runner")).status).toBe(202);
    expect((await database.pool.query("SELECT runner_id FROM telemetry_watermark")).rows).toEqual([]);
  });
  it("retains explicitly legacy HTTP behavior when scoped telemetry is off", async () => {
    const legacyApp = app(false);
    expect((await post(legacyApp, poolA, [])).status).toBe(401);
    expect((await post(legacyApp, legacy, [event("legacy-endpoint", "external", { endpointId: "endpoint-a", metadata: { protocol: "litellm" } })], "legacy-runner")).status).toBe(202);
    expect((await database.pool.query("SELECT project_id FROM runtime_event WHERE id='legacy-endpoint'")).rows).toEqual([{ project_id: "projectA" }]);
    expect((await database.pool.query("SELECT runner_id FROM telemetry_watermark WHERE runner_id='legacy-runner'")).rowCount).toBe(1);
  });
  it("does not let a different pool enrich a valid event or update quarantined routing evidence", async () => {
    const scoped = app(true);
    const row = (await database.pool.query("SELECT occurred_at, metadata FROM runtime_event WHERE id='own'")).rows[0];
    const forged = event("own", "playground:a", { occurredAt: row.occurred_at.toISOString(), metadata: { protocol: "playground", runtimeLogCaptured: true, contentCiphertext: "forged" } });
    const assignment = (await database.pool.query("SELECT occurred_at FROM route_assignment WHERE decision_id='d1'")).rows[0];
    const completion = { id: "r2", eventType: "completion", decisionId: "d1", callId: "c1", runnerId: "claimed-runner", endpointId: "endpoint-a",
      routerId: "", routerRevision: 0, routeId: "", targetId: "", guardrailId: "", guardrailVersion: "", occurredAt: new Date().toISOString(), decisionAt: assignment.occurred_at.toISOString(), assignmentStatus: "unassigned", outcome: "error" };
    expect((await post(scoped, poolB, [forged, completion])).status).toBe(202);
    const after = (await database.pool.query("SELECT project_id, metadata FROM runtime_event WHERE id='own'")).rows[0];
    expect(after.project_id).toBe("projectA");
    expect(after.metadata).toEqual(row.metadata);
    expect((await database.pool.query("SELECT project_id, outcome FROM route_assignment WHERE decision_id='d1'")).rows).toEqual([{ project_id: null, outcome: null }]);
  });
});
