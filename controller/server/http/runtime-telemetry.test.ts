import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
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
    ["admin", "", false],
    ["admin", "?includeContent=false", false],
    ["admin", "?includeContent=true", true],
    ["user", "?includeContent=true", false],
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
