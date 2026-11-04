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
const tokenA = "pool-a-control-token-that-is-at-least-32-characters";
const tokenC = "pool-c-control-token-that-is-at-least-32-characters";
const version = "20260912-083000.123Z";
const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://unused:unused@localhost/unused",
  CONTROLLER_RUNNER_TOKEN: "legacy-token-that-is-at-least-32-characters", BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
  CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ "pool-a": tokenA, "pool-c": tokenC }),
  CONTROLLER_RUNNER_SCOPED_TELEMETRY: "true", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem" });
const endpoint = { endpointId: "endpoint-a", projectId: "projectA", adapter: "litellm-generic-guardrail", trafficRouterId: "router-a", verification: { credentials: [] }, scanFlagOnlyDefault: true };
const router = { routerId: "router-a", revision: 3, routes: [{ id: "route-a", enabled: true, targets: [{ id: "target-c", guardrailId: "shared-c", guardrailVersion: version, weightBps: 10000 }] }] };

describe.skipIf(!url)("immutable Endpoint telemetry allocation context", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  let contextId: string;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "endpoint_telemetry_context");
    service = new ControlPlaneService(database.db, config);
    await database.pool.query(`INSERT INTO guardrail(id,project_id,name,draft_config) VALUES ('shared-c','projectC','Shared C','{}');
      INSERT INTO endpoint(id,project_id,name,adapter) VALUES ('endpoint-a','projectA','A','litellm-generic-guardrail');
      INSERT INTO project_group(id,name) VALUES ('group-a','A'),('group-c','C');
      INSERT INTO runner_pool(id,name,group_id,project_id) VALUES ('pool-a','A','group-a','projectA');
      UPDATE project SET group_id='group-a' WHERE id='projectA';
      INSERT INTO controller_state(id,desired_generation) VALUES ('singleton',9) ON CONFLICT(id) DO NOTHING;`);
    const desired = await service.desiredStateForPool("pool-a");
    const projected = desired.endpoints.find(row => row.endpointId === "endpoint-a");
    expect(projected?.telemetryContextId).toBeTruthy();
    expect((await database.pool.query("SELECT project_id,pool_id,group_id,verification_digest FROM endpoint_telemetry_context WHERE id=$1", [projected!.telemetryContextId])).rows[0])
      .toMatchObject({ project_id: "projectA", pool_id: "pool-a", group_id: "group-a", verification_digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    contextId = (await database.db.transaction(tx => issueEndpointTelemetryContexts(tx, {
      poolId: "pool-a", groupId: "group-a", epoch: 7, generation: 9, endpoints: [endpoint], routers: [router],
    }))).get("endpoint-a")!;
  }, 30000);
  afterAll(async () => { await database?.drop(); });
  const app = () => createHttpApp({ config, service, auth: { api: { getSession: vi.fn() } } as unknown as ControllerAuth,
    runnerControl: {} as RunnerControlServer, metrics: { registry: new Registry() } as ControllerMetrics });
  const event = (id: string, overrides: Record<string, unknown> = {}) => ({ id, requestId: `call:${id}`, occurredAt: new Date().toISOString(),
    runnerId: "runner-a", endpointId: "endpoint-a", routerId: "router-a", guardrailId: "shared-c", guardrailVersion: version,
    allocationContextId: contextId, direction: "incoming", decision: "allow", durationMs: 2,
    metadata: { protocol: "litellm", routeId: "route-a", targetId: "target-c", routerRevision: 3,
      usage: { model_calls: [{ call_id: "model-call", provider: "synthetic", model: "synthetic", usage_known: true, input_tokens: 1, output_tokens: 1 }] } }, ...overrides });
  const post = (events: unknown[], token = tokenA) => app().request("/api/internal/v1/runtime-events", { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ events }) });
  const owner = async (id: string) => (await database.pool.query("SELECT project_id FROM runtime_event WHERE id=$1", [id])).rows[0]?.project_id;

  it("attributes valid Endpoint events and costs to the snapshot owner, including a foreign shared Guardrail", async () => {
    expect((await post([event("own-context")])).status).toBe(202);
    expect(await owner("own-context")).toBe("projectA");
    expect((await database.pool.query("SELECT project_id, allocation_context_id FROM model_usage_cost WHERE event_id='own-context'")).rows)
      .toEqual([{ project_id: "projectA", allocation_context_id: contextId }]);
    expect(JSON.stringify(await service.getRuntimeEvent("own-context"))).not.toContain(contextId);
    expect(JSON.stringify(await service.queryRuntimeEvents({}))).not.toContain(contextId);
    expect((await database.pool.query("SELECT * FROM telemetry_watermark")).rows).toEqual([]);
  });
  it("quarantines wrong-pool, unknown and mismatched frozen identities without poisoning a mixed batch", async () => {
    expect((await post([event("wrong-pool")], tokenC)).status).toBe(202);
    const cases = [event("unknown-context", { allocationContextId: "unknown" }), event("no-context", { allocationContextId: undefined }), event("other-endpoint", { endpointId: "endpoint-c" }),
      event("other-router", { routerId: "router-c" }), event("other-version", { guardrailVersion: "20260913-083000.123Z" }),
      event("other-target", { metadata: { ...event("x").metadata, targetId: "forged-target" } }),
      event("other-revision", { metadata: { ...event("x").metadata, routerRevision: 4 } }),
      event("no-routing-identity", { metadata: { protocol: "litellm" } }),
      event("wrong-protocol", { metadata: { ...event("x").metadata, protocol: "scan" } }), event("mixed-good")];
    expect((await post(cases)).status).toBe(202);
    for (const id of ["wrong-pool", ...cases.slice(0, -1).map(row => row.id)]) {
      expect(await owner(id)).toBeNull();
      expect((await database.pool.query("SELECT project_id FROM model_usage_cost WHERE event_id=$1", [id])).rows.every(row => row.project_id === null)).toBe(true);
    }
    expect(await owner("mixed-good")).toBe("projectA");
  });
  it("keeps delayed genuine events with their historical owner after retirement and reallocation", async () => {
    const delayed = event("delayed-before-move");
    await database.db.transaction(tx => retireEndpointTelemetryContexts(tx, ["pool-a"]));
    const reincarnated = (await database.db.transaction(tx => issueEndpointTelemetryContexts(tx, {
      poolId: "pool-a", groupId: "group-a", epoch: 7, generation: 9, endpoints: [endpoint], routers: [router],
    }))).get("endpoint-a")!;
    expect(reincarnated).not.toBe(contextId);
    expect((await database.pool.query("SELECT retired_at FROM endpoint_telemetry_context WHERE id=$1", [contextId])).rows[0].retired_at).not.toBeNull();
    await database.db.transaction(tx => retireEndpointTelemetryContexts(tx, ["pool-a"]));
    await database.pool.query("UPDATE runner_pool SET group_id='group-c' WHERE id='pool-a'; UPDATE endpoint SET project_id='projectC' WHERE id='endpoint-a'");
    expect((await post([delayed])).status).toBe(202);
    expect(await owner("delayed-before-move")).toBe("projectA");
    const newer = (await database.db.transaction(tx => issueEndpointTelemetryContexts(tx, {
      poolId: "pool-a", groupId: "group-c", epoch: 8, generation: 10, endpoints: [{ ...endpoint, projectId: "projectC" }], routers: [router],
    }))).get("endpoint-a")!;
    expect(newer).not.toBe(contextId);
    expect((await post([event("new-owner", { allocationContextId: newer })])).status).toBe(202);
    expect(await owner("new-owner")).toBe("projectC");
    await database.pool.query(`INSERT INTO endpoint_telemetry_context(id,snapshot_key,project_id,group_id,pool_id,allocation_epoch,generation,endpoint_id,adapter,
        verification_digest,endpoint_snapshot_digest,router_id,router_revision,router_snapshot_digest,targets,issued_at,retired_at)
      SELECT 'expired-context','expired-key',project_id,group_id,pool_id,allocation_epoch,generation,endpoint_id,adapter,
        verification_digest,endpoint_snapshot_digest,router_id,router_revision,router_snapshot_digest,targets,now()-interval '1 hour',now()-interval '20 minutes'
      FROM endpoint_telemetry_context WHERE id=$1`, [contextId]);
    expect((await post([event("past-retirement-grace", { allocationContextId: "expired-context" })])).status).toBe(202);
    expect(await owner("past-retirement-grace")).toBeNull();
  });
  it("enforces immutable authority and one-way retirement in PostgreSQL", async () => {
    for (const assignment of ["id='changed-id'", "snapshot_key='changed-key'", "project_id='projectC'", "group_id='group-c'", "pool_id='pool-c'", "allocation_epoch=999", "generation=999",
      "endpoint_id='other'", "adapter='f5-scan'", "verification_digest='changed'", "endpoint_snapshot_digest='changed'", "router_id='other'",
      "router_revision=999", "router_snapshot_digest='changed'", "targets='[]'::jsonb", "issued_at=now()-interval '1 hour'", "retired_at=NULL", "retired_at=now()"])
      await expect(database.pool.query(`UPDATE endpoint_telemetry_context SET ${assignment} WHERE id=$1`, [contextId])).rejects.toThrow("immutable");
    await expect(database.pool.query("DELETE FROM endpoint_telemetry_context WHERE id=$1", [contextId])).rejects.toThrow("retained or referenced");
  });
});
