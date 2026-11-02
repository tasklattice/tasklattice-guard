// @vitest-environment node
import { resolve } from "node:path";
import { Registry } from "prom-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpApp } from "./app.js";
import { loadConfig } from "../config.js";
import type { ControllerAuth } from "../auth.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";

const snapshot = {
  running: false, mode: "shared", sampleIntervalMs: 1000,
  fakeLlm: { fixedLatencyMs: 120, p95Ms: null, active: 0, capacity: 1024, completed: 0 },
  runner: { ready: true, inflight: 0, queue: 0, capacity: 1 },
  groups: [{ id: "default", name: "Default group", tenantIds: ["tenantA", "tenantB", "tenantC"], poolIds: ["default"],
    runner: { ready: true, metricsAvailable: false, inflight: 0, queue: 0, capacity: 0 } }],
  tenants: ["tenantA", "tenantB", "tenantC"].map(id => ({
    id, name: id, color: "#0f62fe", slotBudget: 4, inflight: 0, queued: 0,
    groupId: "default", groupName: "Default group", poolId: "default",
    offeredRps: 0, completedRps: 0, occupancyPercent: 0, p50Ms: null, p95Ms: null,
    guardP95Ms: null, modelP95Ms: null, queueP95Ms: null, errors: 0, completed: 0, peakUntil: null,
  })), history: [], events: [], limits: { maxRps: 120, maxInflight: 64, queueLimit: 64 },
  measurement: { occupancyDefinition: "In-flight synthetic client pipelines / four reference slots", quotaSimulation: false, runnerMetricsAvailable: false,
    runnerMetricsDefinition: "Real Runner gauges summed once per configured pool." },
};

function setup(role: string | null = "admin", configured = true, poolId = "default") {
  const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://unused:unused@localhost/unused",
    CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem",
    CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
    ...(configured ? { CONTROLLER_TENANT_LOAD_LAB_URL: "http://synthetic-lab:38110" } : {}),
  });
  return createHttpApp({ config,
    auth: { api: { getSession: vi.fn().mockResolvedValue(role ? { user: { id: "actor", role, tenantId: "tenantA" } } : null) } } as unknown as ControllerAuth,
    service: { groupRouting: { poolsForTenant: vi.fn(async () => [{ id: poolId, groupId: "default" }]) } } as unknown as ControlPlaneService, runnerControl: {} as RunnerControlServer,
    metrics: { registry: new Registry() } as ControllerMetrics,
  });
}

describe("administrator tenant load lab", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([null, "user"])("denies role %s before contacting the workload service", async role => {
    const transport = vi.fn(); vi.stubGlobal("fetch", transport);
    const app = setup(role);
    for (const [path, method, body] of [["state", "GET", undefined], ["control", "POST", JSON.stringify({ action: "start" })]] as const) {
      const response = await app.request(`/api/v1/tenant-load-lab/${path}`, { method, ...(body ? { body, headers: { "content-type": "application/json" } } : {}) });
      expect(response.status).toBe(role ? 403 : 401);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("returns sanitized, uncached aggregate measurements to an administrator", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...snapshot, credential: "private-fixture-key", privateConfiguration: {} })));
    const response = await setup().request("/api/v1/tenant-load-lab/state");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ...snapshot, tenants: snapshot.tenants.map(tenant => ({ ...tenant,
      blocked: 0, inputBlocked: 0, outputBlocked: 0, transformed: 0,
    })) });
  });

  it("preserves separate policy counters without adding blocks to delivered throughput", async () => {
    const measured = { ...snapshot, tenants: snapshot.tenants.map(tenant => ({ ...tenant,
      blocked: 5, inputBlocked: 2, outputBlocked: 3, transformed: 4, completed: 7, completedRps: 1,
    })) };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(measured)));
    const response = await setup().request("/api/v1/tenant-load-lab/state");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(measured);
  });

  it("rejects invalid policy counters instead of displaying corrupt measurements", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...snapshot,
      tenants: snapshot.tenants.map(tenant => ({ ...tenant, blocked: -1 })),
    })));
    expect((await setup().request("/api/v1/tenant-load-lab/state")).status).toBe(503);
  });

  it("validates tenant identity and bounded duration before dispatching peak work", async () => {
    const transport = vi.fn(async () => Response.json(snapshot)); vi.stubGlobal("fetch", transport);
    const app = setup();
    for (const body of [{ action: "peak", tenantId: "foreign", durationSeconds: 30 }, { action: "peak", tenantId: "tenantA", durationSeconds: 3600 }, { action: "start", targetUrl: "http://external.invalid" }]) {
      expect((await app.request("/api/v1/tenant-load-lab/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect(transport).not.toHaveBeenCalled();
    const response = await app.request("/api/v1/tenant-load-lab/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "peak", tenantId: "tenantB", durationSeconds: 30 }) });
    expect(response.status).toBe(200);
    expect(String(transport.mock.calls[0]?.[0])).toBe("http://synthetic-lab:38110/state");
    expect(String(transport.mock.calls[1]?.[0])).toBe("http://synthetic-lab:38110/control");
  });

  it("refuses new traffic when the configured pool no longer belongs to the tenant, while still allowing pause", async () => {
    const transport = vi.fn(async () => Response.json(snapshot)); vi.stubGlobal("fetch", transport);
    const app = setup("admin", true, "other-pool");
    const send = (action: string) => app.request("/api/v1/tenant-load-lab/control", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }),
    });
    const response = await send("start");
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("tenant_load_lab_allocation_changed");
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await send("stop")).status).toBe(200);
    expect(String(transport.mock.calls[1]?.[0])).toBe("http://synthetic-lab:38110/control");
  });

  it("stays unavailable without configuration and never exposes upstream transport details", async () => {
    const transport = vi.fn(async () => { throw new Error("private-config-and-credential"); }); vi.stubGlobal("fetch", transport);
    expect((await setup("admin", false).request("/api/v1/tenant-load-lab/state")).status).toBe(503);
    expect(transport).not.toHaveBeenCalled();
    const response = await setup().request("/api/v1/tenant-load-lab/state");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-config-and-credential");
  });
});
