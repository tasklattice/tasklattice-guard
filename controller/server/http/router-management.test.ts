import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

const config = loadConfig({
  NODE_ENV: "test",
  CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
});

describe("Router deletion HTTP routes", () => {
  it("requires an administrator to inspect impact or delete a Router", async () => {
    const app = appWith({ user: { id: "member-1", role: "user" } }, {});

    expect((await app.request("/api/v1/routers/router-1/deletion-impact")).status).toBe(403);
    expect((await app.request("/api/v1/routers/router-1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Retired route" }),
    })).status).toBe(403);
  });

  it("forwards protected soft-delete confirmation and distributes the new desired state", async () => {
    const routerDeletionImpact = vi.fn().mockResolvedValue({
      resourceId: "router-1",
      windowMinutes: 30,
      incomingRequestCount: 12,
      lastRequestAt: "2026-08-24T08:00:00.000Z",
      activeRouterCount: 1,
      telemetryFresh: true,
      telemetryWatermark: "2026-08-24T08:00:01.000Z",
      requiresSecondConfirmation: true,
    });
    const softDeleteRouter = vi.fn().mockResolvedValue(undefined);
    const distributeDesiredState = vi.fn().mockResolvedValue({ desiredGeneration: 8, distributionStatus: "ready" });
    const app = appWith(
      { user: { id: "admin-1", role: "admin" } },
      { routerDeletionImpact, softDeleteRouter },
      distributeDesiredState,
    );

    const impact = await app.request("/api/v1/routers/router-1/deletion-impact");
    const deleted = await app.request("/api/v1/routers/router-1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reason: "Traffic moved to the regional route",
        confirmRecentTraffic: true,
        confirmationName: "Regional traffic",
      }),
    });

    expect(impact.status).toBe(200);
    expect(await impact.json()).toMatchObject({ resourceId: "router-1", incomingRequestCount: 12 });
    expect(deleted.status).toBe(204);
    expect(softDeleteRouter).toHaveBeenCalledWith({
      id: "router-1",
      actorId: "admin-1",
      reason: "Traffic moved to the regional route",
      confirmRecentTraffic: true,
      confirmationName: "Regional traffic",
    });
    expect(distributeDesiredState).toHaveBeenCalledOnce();
  });
});

function appWith(
  session: { user: { id: string; role: string } } | null,
  service: Partial<ControlPlaneService>,
  distributeDesiredState = vi.fn().mockResolvedValue({ desiredGeneration: 7, distributionStatus: "ready" }),
) {
  const auth = {
    api: { getSession: vi.fn().mockResolvedValue(session) },
    handler: vi.fn(),
  } as unknown as ControllerAuth;
  return createHttpApp({
    config,
    auth,
    service: service as ControlPlaneService,
    runnerControl: {
      distributionStatus: vi.fn().mockResolvedValue({ desiredGeneration: 7, distributionStatus: "ready" }),
      distributeDesiredState,
    } as unknown as RunnerControlServer,
    metrics: {} as ControllerMetrics,
  });
}
