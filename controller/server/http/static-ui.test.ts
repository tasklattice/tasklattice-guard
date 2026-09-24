// @vitest-environment node
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
  CONTROLLER_UI_DIST: resolve("public"),
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
});

const app = createHttpApp({
  config,
  auth: { api: { getSession: vi.fn().mockResolvedValue(null) }, handler: vi.fn() } as unknown as ControllerAuth,
  service: {} as ControlPlaneService,
  runnerControl: {} as RunnerControlServer,
  metrics: {} as ControllerMetrics,
});

describe("documentation static assets", () => {
  it("serves both diagrams as PNG files and keeps missing diagrams out of the SPA fallback", async () => {
    for (const name of ["request-decision-v1", "policy-release-v1"]) {
      const response = await app.request(`/docs/diagrams/${name}.png`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^image\/png/);
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100_000);
    }

    const missing = await app.request("/docs/diagrams/not-found.png");
    expect(missing.status).toBe(404);
  });
});
