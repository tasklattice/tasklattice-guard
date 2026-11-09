import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { Registry } from "prom-client";

import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

const metricsToken = "metrics-token-that-is-at-least-32-characters";

describe("Controller metrics authentication", () => {
  it("requires the dedicated token when configured", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
      CONTROLLER_METRICS_TOKEN: metricsToken,
      CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
      CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
    });
    const metrics = {
      render: vi.fn().mockResolvedValue("guard_controller_desired_generation 1\n"),
      registry: new Registry(),
    } as unknown as ControllerMetrics;
    const app = createHttpApp({
      config,
      auth: { handler: vi.fn(), api: {} } as unknown as ControllerAuth,
      service: {} as ControlPlaneService,
      runnerControl: {} as RunnerControlServer,
      metrics,
    });

    expect((await app.request("/metrics")).status).toBe(401);
    const accepted = await app.request("/metrics", {
      headers: { authorization: `Bearer ${metricsToken}` },
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toContain("guard_controller_desired_generation");
  });

  it("uses the Hono registered route template for bounded HTTP RED metrics", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
      CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
      CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
    });
    const registry = new Registry();
    const metrics = {
      render: vi.fn(), registry,
    } as unknown as ControllerMetrics;
    const service = {
      listRunnerPoolsWithCapacity: vi.fn().mockResolvedValue([]),
      desiredGeneration: vi.fn().mockResolvedValue(3),
    } as unknown as ControlPlaneService;
    const app = createHttpApp({
      config,
      auth: { handler: vi.fn(), api: {} } as unknown as ControllerAuth,
      service,
      runnerControl: {} as RunnerControlServer,
      metrics,
    });

    const response = await app.request("/api/v1/system/status");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "unavailable",
      reasons: ["no_connected_runners"],
      desiredGeneration: 3,
      components: {
        controller: { status: "operational" },
        runnerFleet: { status: "unavailable", servingRunners: 0, connectedRunners: 0 },
        controlPlaneModel: { status: "unconfigured", provider: null, model: null },
        runtimeModels: { status: "unconfigured", models: [] },
      },
    });
    const rendered = await registry.metrics();
    expect(rendered).toContain(
      'guard_controller_http_requests_total{method="GET",route="/api/v1/system/status",status="503",ok="false"} 1',
    );
  });
});
