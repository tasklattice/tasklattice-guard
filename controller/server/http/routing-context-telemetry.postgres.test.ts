// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Registry } from "prom-client";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { loadConfig } from "../config.js";
import type { ControllerAuth } from "../auth.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import { ControlPlaneService } from "../services/control-plane.js";
import { issueEndpointTelemetryContexts, retireEndpointTelemetryContexts } from "../services/endpoint-telemetry-contexts.js";
import { createHttpApp } from "./app.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
const tokenA = "pool-a-routing-token-at-least-32-characters";
const tokenC = "pool-c-routing-token-at-least-32-characters";
const version = "20260912-083000.123Z";
const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://unused:unused@localhost/unused",
  CONTROLLER_RUNNER_TOKEN: "legacy-token-that-is-at-least-32-characters", BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
  CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ "pool-a": tokenA, "pool-c": tokenC }),
  CONTROLLER_RUNNER_SCOPED_TELEMETRY: "true", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem" });
const endpoint = { endpointId: "endpoint-a", projectId: "projectA", adapter: "litellm-generic-guardrail", trafficRouterId: "router-a", verification: { credentials: [] }, scanFlagOnlyDefault: true };
const router = { routerId: "router-a", revision: 3, routes: [{ id: "route-a", enabled: true, targets: [{ id: "target-c", guardrailId: "shared-c", guardrailVersion: version, weightBps: 10000 }] }] };

describe.skipIf(!url)("pool-bound archived routing provenance", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  let contextId: string;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "routing_telemetry_context");
    service = new ControlPlaneService(database.db, config);
    await database.pool.query(`INSERT INTO guardrail(id,project_id,name,draft_config) VALUES ('shared-c','projectC','Shared C','{}');
      INSERT INTO endpoint(id,project_id,name,adapter) VALUES ('endpoint-a','projectA','A','litellm-generic-guardrail');
      INSERT INTO project_group(id,name) VALUES ('group-a','A'),('group-c','C');
      UPDATE project SET group_id='group-a' WHERE id='projectA';
      INSERT INTO runner_pool(id,name,group_id,project_id) VALUES ('pool-a','A','group-a','projectA');`);
    contextId = (await database.db.transaction(tx => issueEndpointTelemetryContexts(tx, {
      poolId: "pool-a", groupId: "group-a", epoch: 7, generation: 9, endpoints: [endpoint], routers: [router],
    }))).get("endpoint-a")!;
  }, 30000);
  afterAll(async () => { await database?.drop(); });
  const app = () => createHttpApp({ config, service, auth: { api: { getSession: vi.fn() } } as unknown as ControllerAuth,
    runnerControl: {} as RunnerControlServer, metrics: { registry: new Registry() } as ControllerMetrics });
  const event = (id: string, overrides: Record<string, unknown> = {}) => {
    const at = new Date().toISOString();
    return { id: `${id}:assignment`, eventType: "route_assignment", decisionId: id, callId: `call:${id}`, occurredAt: at, decisionAt: at,
      runnerId: "runner-a", endpointId: "endpoint-a", routerId: "router-a", routerRevision: 3, routeId: "route-a", targetId: "target-c",
      guardrailId: "shared-c", guardrailVersion: version, assignmentStatus: "assigned", allocationContextId: contextId, ...overrides };
  };
  const post = (events: unknown[], token = tokenA) => app().request("/api/internal/v1/runtime-events", { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ events }) });
  const row = async (id: string) => (await database.pool.query("SELECT * FROM route_assignment WHERE decision_id=$1", [id])).rows[0];

  it("deduplicates completion-before-assignment and pins owner/context without publishing watermarks", async () => {
    const assignment = event("own");
    const completion = { ...assignment, id: "own:completion", eventType: "completion", outcome: "error", durationMs: 17 };
    expect((await post([completion, assignment, completion, assignment])).status).toBe(202);
    expect(await row("own")).toMatchObject({ project_id: "projectA", allocation_context_id: contextId, outcome: "error", duration_ms: 17 });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM route_assignment WHERE decision_id='own'")).rows[0].count).toBe(1);
    expect(JSON.stringify(await service.getRuntimeEvent("call:own"))).not.toContain(contextId);
    expect((await database.pool.query("SELECT * FROM telemetry_watermark")).rows).toEqual([]);
  });
  it("quarantines foreign pools, unknown contexts and every conflicting routing identity", async () => {
    expect((await post([event("wrong-pool")], tokenC)).status).toBe(202);
    const cases = [event("missing", { allocationContextId: undefined }), event("unknown", { allocationContextId: "forged-context" }),
      event("endpoint", { endpointId: "other" }), event("router", { routerId: "other" }), event("revision", { routerRevision: 4 }),
      event("route", { routeId: "other" }), event("target", { targetId: "other" }), event("guardrail", { guardrailId: "other" }),
      event("version", { guardrailVersion: "other" }), event("bad-unassigned", { assignmentStatus: "unassigned" })];
    expect((await post(cases)).status).toBe(202);
    for (const id of ["wrong-pool", ...cases.map(item => item.decisionId)]) expect((await row(id)).project_id).toBeNull();
    const unassigned = event("unassigned", { assignmentStatus: "unassigned", targetId: "", guardrailId: "", guardrailVersion: "", failureReason: "route_assignment_failed" });
    expect((await post([unassigned])).status).toBe(202);
    expect((await row("unassigned")).project_id).toBe("projectA");
  });
  it("does not enrich a valid assignment from another pool or promote historical unknown rows", async () => {
    const assignment = event("protected");
    expect((await post([assignment])).status).toBe(202);
    const forged = { ...assignment, id: "protected:completion", eventType: "completion", outcome: "error", durationMs: 99 };
    expect((await post([forged], tokenC)).status).toBe(202);
    expect(await row("protected")).toMatchObject({ project_id: "projectA", outcome: null, completed_at: null });
    const old = event("historical", { allocationContextId: undefined });
    expect((await post([old])).status).toBe(202);
    expect((await post([{ ...old, allocationContextId: contextId, id: "historical:completion", eventType: "completion", outcome: "allow" }])).status).toBe(202);
    expect(await row("historical")).toMatchObject({ project_id: null, allocation_context_id: null, outcome: null });
  });
  it("preserves delayed old-context completion after a move and rejects changing a decision's context", async () => {
    const assignment = event("delayed");
    expect((await post([assignment])).status).toBe(202);
    await database.db.transaction(tx => retireEndpointTelemetryContexts(tx, ["pool-a"]));
    await database.pool.query("UPDATE runner_pool SET group_id='group-c' WHERE id='pool-a'; UPDATE endpoint SET project_id='projectC' WHERE id='endpoint-a'");
    expect((await post([{ ...assignment, id: "delayed:completion", eventType: "completion", outcome: "allow", durationMs: 12 }])).status).toBe(202);
    expect(await row("delayed")).toMatchObject({ project_id: "projectA", allocation_context_id: contextId, outcome: "allow" });
    const newer = (await database.db.transaction(tx => issueEndpointTelemetryContexts(tx, {
      poolId: "pool-a", groupId: "group-c", epoch: 8, generation: 10, endpoints: [{ ...endpoint, projectId: "projectC" }], routers: [router],
    }))).get("endpoint-a")!;
    expect((await post([{ ...assignment, allocationContextId: newer, id: "delayed:forged", eventType: "completion", outcome: "error", durationMs: 900 }])).status).toBe(202);
    expect(await row("delayed")).toMatchObject({ project_id: "projectA", allocation_context_id: contextId, outcome: "allow", duration_ms: 12 });
  });
  it("uses a supplied transaction so routing persistence rolls back with a failed cursor ACK", async () => {
    const parsed = (await import("../services/traffic-routing.js")).routingEventSchema.parse(event("rollback"));
    await expect(database.db.transaction(async tx => {
      await service.trafficRouting.recordEvents([parsed], true, "pool-a", tx);
      throw new Error("ack failed");
    })).rejects.toThrow("ack failed");
    expect(await row("rollback")).toBeUndefined();
  });
});
