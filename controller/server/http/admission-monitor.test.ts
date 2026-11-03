// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { Registry } from "prom-client";
import { createHttpApp } from "./app.js";
import { loadConfig } from "../config.js";
import type { ControllerAuth } from "../auth.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";

function setup(role: string | null) {
  const view = vi.fn(async () => ({ observedAt: 1, source: "authenticated_runner_heartbeat", controllerLocal: true, staleAfterMs: 30000,
    available: false, reason: "measurements_unavailable", selectedPoolId: null, pools: [], groups: [], tenants: [], sources: [] }));
  const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://unused:unused@localhost/unused",
    CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
    CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem" });
  const app = createHttpApp({ config,
    auth: { api: { getSession: vi.fn(async () => role ? { user: { id: "actor", role, tenantId: "tenantA" } } : null) } } as unknown as ControllerAuth,
    service: { admissionMonitor: { view } } as unknown as ControlPlaneService, runnerControl: {} as RunnerControlServer,
    metrics: { registry: new Registry() } as ControllerMetrics });
  return { app, view };
}
describe("platform admission monitor API", () => {
  it.each([null, "user"])("denies role %s before accessing monitoring state", async role => {
    const { app, view } = setup(role); expect((await app.request("/api/v1/tenant-admission-monitor")).status).toBe(role ? 403 : 401);
    expect(view).not.toHaveBeenCalled();
  });
  it("returns uncached internal measurements and bounded source-pool filtering", async () => {
    const { app, view } = setup("admin");
    const response = await app.request("/api/v1/tenant-admission-monitor?poolId=pool-c");
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(view).toHaveBeenCalledWith("pool-c"); expect((await response.json()).source).toBe("authenticated_runner_heartbeat");
  });
  it("rejects client-selected metrics locations and invalid filter identities", async () => {
    const { app, view } = setup("admin");
    for (const query of ["metricsUrl=http://private.invalid", "poolId=", `poolId=${"x".repeat(257)}`])
      expect((await app.request(`/api/v1/tenant-admission-monitor?${query}`)).status).toBe(400);
    expect(view).not.toHaveBeenCalled();
  });
});
