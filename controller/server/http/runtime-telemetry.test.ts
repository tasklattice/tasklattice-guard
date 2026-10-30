import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

const token = "runner-token-that-is-at-least-32-characters";
const config = loadConfig({
  NODE_ENV: "test",
  CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  CONTROLLER_RUNNER_TOKEN: token,
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
});

describe("Runner telemetry channel", () => {
  it("returns pool metrics during a database outage and rejects new work while draining", async () => {
    const blocked = Promise.withResolvers<number>();
    const service = { desiredGeneration: vi.fn(() => blocked.promise), listRunnerPoolsWithCapacity: vi.fn(async () => []),
      observabilitySnapshot: vi.fn(async () => ({ watermarks: [], pendingOutbox: [], guardrails: [], endpoints: [], endpointBindings: [], routers: [] })),
      databasePoolState: () => ({ max: 20, total: 20, busy: 20, idle: 0, waiting: 4 }), recordRuntimeEvents: vi.fn(),
    } as unknown as ControlPlaneService;
    const metrics = new ControllerMetrics();
    let stopping = false;
    const app = createHttpApp({ config, auth: { api: {} } as ControllerAuth, service,
      runnerControl: {} as RunnerControlServer, metrics, isStopping: () => stopping });
    const response = await app.request("/metrics");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("guard_controller_database_pool_waiting 4");
    stopping = true;
    expect((await app.request("/health/ready")).status).toBe(503);
    expect((await app.request("/api/internal/v1/runtime-events", { method: "POST" })).status).toBe(503);
    expect((await app.request("/health/live")).status).toBe(200);
    expect(service.recordRuntimeEvents).not.toHaveBeenCalled();
    expect(service.desiredGeneration).toHaveBeenCalledOnce();
    blocked.resolve(3); await metrics.stop();
  });

  it("logs pool pressure and SQLSTATE without leaking SQL parameters, error detail or credentials", async () => {
    const secret = "PRIVATE_REPORT_AND_DATABASE_PASSWORD";
    const error = Object.assign(new Error(`Failed query: ${secret}`), {
      params: [secret], cause: Object.assign(new Error(secret), { code: "53300", detail: secret, client: { password: secret } }),
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = createHttpApp({ config, auth: { api: {} } as ControllerAuth,
        service: { recordRuntimeEvents: vi.fn().mockRejectedValue(error),
          databasePoolState: () => ({ max: 20, total: 20, busy: 20, idle: 0, waiting: 5 }),
        } as unknown as ControlPlaneService,
        runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics,
      });
      const response = await app.request("/api/internal/v1/runtime-events", { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ events: [], runnerId: "runner-0" }),
      });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(secret);
      expect(JSON.stringify(logged.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(logged.mock.calls)).not.toContain(token);
      expect(JSON.parse(logged.mock.calls[0]![0])).toMatchObject({ event: "controller.http_error",
        method: "POST", route: "/api/internal/v1/runtime-events",
        pool: { total: 20, busy: 20, waiting: 5 }, error: { code: "53300", sqlState: "53300", category: "too_many_connections" },
      });
    } finally { logged.mockRestore(); }
  });

  it("accepts a zero-traffic watermark from an authenticated Runner", async () => {
    const recordRuntimeEvents = vi.fn().mockResolvedValue(undefined);
    const recordTelemetryWatermark = vi.fn().mockResolvedValue(undefined);
    const app = createHttpApp({
      config,
      auth: { handler: vi.fn(), api: {} } as unknown as ControllerAuth,
      service: { recordRuntimeEvents, recordTelemetryWatermark } as unknown as ControlPlaneService,
      runnerControl: {} as RunnerControlServer,
      metrics: {} as ControllerMetrics,
    });

    const response = await app.request("/api/internal/v1/runtime-events", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ events: [], runnerId: "runner-0", observedAt: new Date().toISOString() }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: 0 });
    expect(recordRuntimeEvents).toHaveBeenCalledWith([]);
    expect(recordTelemetryWatermark).toHaveBeenCalledWith("runner-0");
  });

  it("does not accept an anonymous empty telemetry batch", async () => {
    const app = createHttpApp({
      config,
      auth: { handler: vi.fn(), api: {} } as unknown as ControllerAuth,
      service: {} as ControlPlaneService,
      runnerControl: {} as RunnerControlServer,
      metrics: {} as ControllerMetrics,
    });

    const response = await app.request("/api/internal/v1/runtime-events", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });

    expect(response.status).toBe(400);
  });
});


describe("runtime content opt-in", () => {
  it.each([
    ["user", "", false],
    ["user", "?includeContent=false", false],
    ["user", "?includeContent=true", true],
  ])("%s reading %s only decrypts when explicitly authorized", async (role, query, includeContent) => {
    const getRuntimeEvent = vi.fn().mockResolvedValue({ id: "event", metadata: {} });
    const app = createHttpApp({ config,
      auth: { api: { getSession: vi.fn().mockResolvedValue({ user: { id: "reader", role } }) } } as unknown as ControllerAuth,
      service: { getRuntimeEvent } as unknown as ControlPlaneService,
      runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics,
    });
    const response = await app.request(`/api/v1/telemetry/events/event${query}`);
    expect(response.status).toBe(200);
    expect(getRuntimeEvent).toHaveBeenCalledWith("event", includeContent);
  });
});


describe("Security Event multi-select filter", () => {
  it.each([["critical,high", 200], ["unclassified,informational", 200], ["high,invalid", 400], ["", 400]])("validates the complete filter %s", async (severity, status) => {
    const queryRuntimeEvents = vi.fn().mockResolvedValue({ items: [], count: 0 });
    const app = createHttpApp({ config,
      auth: { api: { getSession: vi.fn().mockResolvedValue({ user: { id: "reader", role: "user" } }) } } as unknown as ControllerAuth,
      service: { queryRuntimeEvents } as unknown as ControlPlaneService,
      runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics,
    });
    const response = await app.request(`/api/v1/telemetry/events?severity=${severity}`);
    expect(response.status).toBe(status);
    if (status === 200) expect(queryRuntimeEvents).toHaveBeenCalledWith(expect.objectContaining({ severity: severity.split(",") }));
    else expect(queryRuntimeEvents).not.toHaveBeenCalled();
  });
});

describe("Security Event item pagination API", () => {
  function setup(role = "user") {
    const querySecurityEvents = vi.fn().mockResolvedValue({ items: [], count: 0, nextCursor: null });
    const app = createHttpApp({ config,
      auth: { api: { getSession: vi.fn().mockResolvedValue({ user: { id: "reader", role } }) } } as unknown as ControllerAuth,
      service: { querySecurityEvents } as unknown as ControlPlaneService,
      runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics,
    });
    return { app, querySecurityEvents };
  }
  it("defaults to 25 and validates the 50-item page and complete filter", async () => {
    const { app, querySecurityEvents } = setup();
    expect((await app.request("/api/v1/telemetry/security-events?guardrailId=guard")).status).toBe(200);
    expect(querySecurityEvents).toHaveBeenLastCalledWith({ guardrailId: "guard", window: "24h", limit: 25 });
    expect((await app.request("/api/v1/telemetry/security-events?guardrailId=guard&limit=50&window=7d&severity=high,critical&until=2026-10-15T08:00:00Z&cursor=older")).status).toBe(200);
    expect(querySecurityEvents).toHaveBeenLastCalledWith({ guardrailId: "guard", window: "7d", limit: 50, severity: ["critical", "high"], until: "2026-10-15T08:00:00Z", cursor: "older" });
  });
  it.each(["limit=100", "limit=0", "limit=26", "limit=25.5", "severity=bad", "severity=", "until=invalid", "window=bad"])("rejects invalid %s before querying", async query => {
    const { app, querySecurityEvents } = setup();
    expect((await app.request(`/api/v1/telemetry/security-events?guardrailId=guard&${query}`)).status).toBe(400);
    expect(querySecurityEvents).not.toHaveBeenCalled();
  });
  it("requires a Guardrail scope and denies platform administrators", async () => {
    const { app, querySecurityEvents } = setup();
    expect((await app.request("/api/v1/telemetry/security-events")).status).toBe(400);
    const admin = setup("admin");
    expect((await admin.app.request("/api/v1/telemetry/security-events?guardrailId=guard")).status).toBe(403);
    expect(querySecurityEvents).not.toHaveBeenCalled();
    expect(admin.querySecurityEvents).not.toHaveBeenCalled();
  });
});

describe("runtime log outcome filter", () => {
  it.each([["allow", 200], ["block", 200], ["transform", 200], ["error", 200], ["timeout", 400]])("accepts enforcement outcomes and the error log filter: %s", async (outcome, status) => {
    const queryRuntimeEvents = vi.fn().mockResolvedValue({ items: [], count: 0 });
    const app = createHttpApp({ config,
      auth: { api: { getSession: vi.fn().mockResolvedValue({ user: { id: "reader", role: "user" } }) } } as unknown as ControllerAuth,
      service: { queryRuntimeEvents } as unknown as ControlPlaneService,
      runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics,
    });
    const response = await app.request(`/api/v1/telemetry/events?outcome=${outcome}`);
    expect(response.status).toBe(status);
    if (status === 200) expect(queryRuntimeEvents).toHaveBeenCalledWith(expect.objectContaining({ outcome }));
    else expect(queryRuntimeEvents).not.toHaveBeenCalled();
  });
});
