// @vitest-environment node
import { runnerAuthEnv } from "../../test/runner-auth-fixture.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Registry } from "prom-client";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { loadConfig } from "../config.js";
import type { ControllerAuth } from "../auth.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import { ControlPlaneService } from "../services/control-plane.js";
import { issueEndpointTelemetryContexts } from "../services/endpoint-telemetry-contexts.js";
import { createHttpApp } from "./app.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
const runnerToken = "shared-default-runner-token-at-least-32-characters";
const version = "20260912-083000.123Z";
const env = { NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://unused:unused@localhost/unused",
  ...runnerAuthEnv(runnerToken),
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem",
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" };

describe.skipIf(!url)("Dashboard tenant isolation for a shared Default Runner", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof createHttpApp>;
  let contextIds: Map<string, string>;

  beforeAll(async () => {
    database = await createTestDatabase(url!, "dashboard_isolation");
    const service = new ControlPlaneService(database.db, loadConfig(env));
    const getSession = vi.fn(async ({ headers }: { headers: Headers }) => {
      const project = headers.get("x-test-project");
      return {
        session: { id: `session-${project ?? "platform"}`, activeProjectId: project ?? null },
        user: { id: `user-${project ?? "platform"}`, role: headers.get("x-test-role") ?? "user" },
      };
    });
    app = createHttpApp({
      config: loadConfig(env), service, auth: { api: { getSession } } as unknown as ControllerAuth,
      runnerControl: {} as RunnerControlServer, metrics: { registry: new Registry() } as ControllerMetrics,
    });
    await database.pool.query(`
      INSERT INTO guardrail (id, project_id, name, draft_config) VALUES
        ('guardrail-a', 'projectA', 'A', '{}'),
        ('guardrail-b', 'projectB', 'B', '{}');
      INSERT INTO endpoint (id, project_id, name, adapter) VALUES
        ('endpoint-a', 'projectA', 'A', 'litellm-generic-guardrail'),
        ('endpoint-b', 'projectB', 'B', 'litellm-generic-guardrail');
    `);
    contextIds = await database.db.transaction(tx => issueEndpointTelemetryContexts(tx, {
      poolId: "default", groupId: "default", epoch: 0, generation: 1,
      endpoints: ["a", "b"].map((suffix, index) => ({ endpointId: `endpoint-${suffix}`,
        projectId: index === 0 ? "projectA" : "projectB", adapter: "litellm-generic-guardrail",
        trafficRouterId: `router-${suffix}`, verification: { credentials: [] }, scanFlagOnlyDefault: true })),
      routers: ["a", "b"].map(suffix => ({ routerId: `router-${suffix}`, revision: 1,
        routes: [{ id: "route", enabled: true, targets: [{ id: "target", guardrailId: `guardrail-${suffix}`,
          guardrailVersion: version, weightBps: 10000 }] }] })),
    }));
  }, 30000);

  afterAll(async () => { await database?.drop(); });

  const post = (events: unknown[]) => app.request("/api/internal/v1/runtime-events", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${runnerToken}` },
    body: JSON.stringify({ events }),
  });

  const event = (id: string, endpointId: string, guardrailId: string) => ({
    id, requestId: `request-${id}`, occurredAt: new Date().toISOString(), runnerId: "shared-default-runner",
    guardrailId, guardrailVersion: version, endpointId, routerId: endpointId.replace("endpoint-", "router-"),
    allocationContextId: contextIds.get(endpointId), direction: "incoming", decision: "allow", durationMs: 3,
    metadata: { protocol: "litellm", routerRevision: 1, routeId: "route", targetId: "target",
      usage: { model_calls: [{ call_id: `${id}-1` }, { call_id: `${id}-2` }], model_invocations: 2 } },
  });

  const read = (path: string, project: string, role = "user") => app.request(path, {
    headers: { "x-test-project": project, "x-test-role": role, ...(project ? { "x-project-id": project } : {}) },
  });

  it("attributes one shared Runner's uploads per tenant and never crosses Dashboard reads", async () => {
    // The Default Pool uploads both projects' events with their Endpoint contexts.
    expect((await post([
      event("event-a", "endpoint-a", "guardrail-a"),
      event("event-b", "endpoint-b", "guardrail-b"),
      // Unknown Endpoint provenance must be quarantined (project_id NULL), not guessed.
      event("event-quarantine", "unknown-endpoint", "guardrail-a"),
    ])).status).toBe(202);
    expect((await database.pool.query("SELECT id, project_id FROM runtime_event ORDER BY id")).rows).toEqual([
      { id: "event-a", project_id: "projectA" },
      { id: "event-b", project_id: "projectB" },
      { id: "event-quarantine", project_id: null },
    ]);

    // Runtime log list: each project sees only its own event.
    const logsA = await (await read("/api/v1/telemetry/events", "projectA")).json();
    expect(logsA.items.map((item: { id: string }) => item.id)).toEqual(["event-a"]);
    const logsB = await (await read("/api/v1/telemetry/events", "projectB")).json();
    expect(logsB.items.map((item: { id: string }) => item.id)).toEqual(["event-b"]);

    // Request statistics and Endpoint activity are project-scoped too.
    const metricsA = await (await read("/api/v1/telemetry/metrics?window=24h", "projectA")).json();
    const metricsB = await (await read("/api/v1/telemetry/metrics?window=24h", "projectB")).json();
    expect(metricsA).toMatchObject({ total_decisions: 1, model_invocations: 2 });
    expect(metricsB).toMatchObject({ total_decisions: 1, model_invocations: 2 });
    expect((await (await read("/api/v1/telemetry/endpoint-activity", "projectA")).json()).items.map((item: { id: string }) => item.id))
      .toEqual(["endpoint-a"]);
    expect((await (await read("/api/v1/telemetry/endpoint-activity", "projectB")).json()).items.map((item: { id: string }) => item.id))
      .toEqual(["endpoint-b"]);

    // A direct detail read of the other tenant's event is a 404, not a payload.
    expect((await read("/api/v1/telemetry/events/event-b", "projectA")).status).toBe(404);
    expect((await read("/api/v1/telemetry/events/event-a", "projectB")).status).toBe(404);

    // Cost view: each tenant only reaches its own Guardrail and sees its own calls.
    const costsA = await (await read("/api/v1/guardrails/guardrail-a/usage-costs?window=7d&source=all", "projectA")).json();
    const costsB = await (await read("/api/v1/guardrails/guardrail-b/usage-costs?window=7d&source=all", "projectB")).json();
    expect(costsA.calls).toBe(2);
    expect(costsB.calls).toBe(2);
    expect((await read("/api/v1/guardrails/guardrail-b/usage-costs?window=7d&source=all", "projectA")).status).toBe(404);
    expect((await read("/api/v1/guardrails/guardrail-a/usage-costs?window=7d&source=all", "projectB")).status).toBe(404);
  });
});
