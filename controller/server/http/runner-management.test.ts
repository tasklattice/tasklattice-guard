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

describe("Runner instance management HTTP routes", () => {
  it.each(["admin"])("lets %s update Runner capacity with its own actor identity", async role => {
    const updateRunnerPool = vi.fn().mockResolvedValue({ id: "pool" });
    const app = appWith({ user: { id: "actor", role, tenantId: "tenantA" } }, { updateRunnerPool });
    const targets = { desiredReplicas: 2, safeRpsPerRunner: 50, maxConcurrencyPerRunner: 64 };
    const response = await app.request("/api/v1/runner-pools/pool", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(targets),
    });
    expect(response.status).toBe(200);
    expect(updateRunnerPool).toHaveBeenCalledExactlyOnceWith({ id: "pool", actorId: "actor", ...targets });
  });
  it("requires authentication for source identities", async () => {
    const app = appWith(null, {});
    expect((await app.request("/api/v1/system/version")).status).toBe(401);
  });
  it("uses each Runner's reported source, retaining unknown metadata for older Runners", async () => {
    const software = { version: "v1.0.0-1-gabcdef-dirty", commit: "abcdef", branch: "main", dirty: true, source: "build" };
    const app = appWith({ user: { id: "user-1", role: "admin", tenantId: "tenantA" } }, {
      listRunnerPoolsWithCapacity: vi.fn().mockResolvedValue([{ id: "default", instances: [
        { runnerId: "new", runnerVersion: software.version, labels: { "tasklattice.build": JSON.stringify(software) }, status: "ready", lastHeartbeatAt: null },
        { runnerId: "old", runnerVersion: "0.2.0", labels: {}, status: "offline", lastHeartbeatAt: null },
      ] }]),
    });
    const response = await app.request("/api/v1/system/version");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.dataPlane[0].software).toEqual(software);
    expect(body.dataPlane[1].software).toMatchObject({ version: "0.2.0", dirty: null, source: "unknown" });
    expect(body.controlPlane).toHaveProperty("commit");
  });
  it.each(["admin"])("lets %s force-remove a syncing registration and closes only the removed boot connection", async role => {
    const removeRunnerInstance = vi.fn().mockResolvedValue({ bootId: "boot-1" });
    const removeRunnerConnection = vi.fn();
    const app = appWith({ user: { id: "actor", role, tenantId: "tenantA" } }, { removeRunnerInstance }, { removeRunnerConnection });
    const response = await app.request("/api/v1/runner-instances/runner-syncing?force=true&bootId=boot-1", { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(removeRunnerInstance).toHaveBeenCalledWith({ runnerId: "runner-syncing", actorId: "actor", force: true, bootId: "boot-1" });
    expect(removeRunnerConnection).toHaveBeenCalledWith("runner-syncing", "boot-1");
  });

  it.each(["force=true", "force=invalid&bootId=boot-1"])("rejects invalid force removal parameters (%s)", async (query) => {
    const removeRunnerInstance = vi.fn();
    const app = appWith({ user: { id: "admin-1", role: "admin", tenantId: "tenantA" } }, { removeRunnerInstance });
    const response = await app.request(`/api/v1/runner-instances/runner-syncing?${query}`, { method: "DELETE" });
    expect(response.status).toBe(400);
    expect(removeRunnerInstance).not.toHaveBeenCalled();
  });

  it.each(["admin"])("forwards offline Runner removal for %s", async role => {
    const removeRunnerInstance = vi.fn().mockResolvedValue(undefined);
    const app = appWith({ user: { id: "actor", role, tenantId: "tenantA" } }, { removeRunnerInstance });

    const response = await app.request("/api/v1/runner-instances/runner-offline", { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(removeRunnerInstance).toHaveBeenCalledWith({
      runnerId: "runner-offline",
      actorId: "actor",
    });
  });
});

function appWith(
  session: { user: { id: string; role: string; tenantId?: string } } | null,
  service: Partial<ControlPlaneService>,
  runnerControl: Partial<RunnerControlServer> = {},
) {
  const auth = {
    api: { getSession: vi.fn().mockResolvedValue(session) },
    handler: vi.fn(),
  } as unknown as ControllerAuth;
  return createHttpApp({
    config,
    auth,
    service: service as ControlPlaneService,
    runnerControl: runnerControl as RunnerControlServer,
    metrics: {} as ControllerMetrics,
  });
}
