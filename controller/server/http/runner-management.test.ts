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
  it("force-removes a syncing registration and closes only the removed boot's connection", async () => {
    const removeRunnerInstance = vi.fn().mockResolvedValue({ bootId: "boot-1" });
    const removeRunnerConnection = vi.fn();
    const app = appWith({ user: { id: "admin-1", role: "admin" } }, { removeRunnerInstance }, { removeRunnerConnection });
    const response = await app.request("/api/v1/runner-instances/runner-syncing?force=true&bootId=boot-1", { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(removeRunnerInstance).toHaveBeenCalledWith({ runnerId: "runner-syncing", actorId: "admin-1", force: true, bootId: "boot-1" });
    expect(removeRunnerConnection).toHaveBeenCalledWith("runner-syncing", "boot-1");
  });

  it.each(["force=true", "force=invalid&bootId=boot-1"])("rejects invalid force removal parameters (%s)", async (query) => {
    const removeRunnerInstance = vi.fn();
    const app = appWith({ user: { id: "admin-1", role: "admin" } }, { removeRunnerInstance });
    const response = await app.request(`/api/v1/runner-instances/runner-syncing?${query}`, { method: "DELETE" });
    expect(response.status).toBe(400);
    expect(removeRunnerInstance).not.toHaveBeenCalled();
  });

  it("does not let a member force-remove a syncing Runner", async () => {
    const removeRunnerInstance = vi.fn();
    const app = appWith({ user: { id: "member-1", role: "user" } }, { removeRunnerInstance });
    const response = await app.request("/api/v1/runner-instances/runner-syncing?force=true&bootId=boot-1", { method: "DELETE" });
    expect(response.status).toBe(403);
    expect(removeRunnerInstance).not.toHaveBeenCalled();
  });
  it("does not allow a member to remove a Runner registration", async () => {
    const removeRunnerInstance = vi.fn();
    const app = appWith({ user: { id: "member-1", role: "user" } }, { removeRunnerInstance });

    const response = await app.request("/api/v1/runner-instances/runner-offline", { method: "DELETE" });

    expect(response.status).toBe(403);
    expect(removeRunnerInstance).not.toHaveBeenCalled();
  });

  it("forwards an offline Runner removal to the service for an administrator", async () => {
    const removeRunnerInstance = vi.fn().mockResolvedValue(undefined);
    const app = appWith({ user: { id: "admin-1", role: "admin" } }, { removeRunnerInstance });

    const response = await app.request("/api/v1/runner-instances/runner-offline", { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(removeRunnerInstance).toHaveBeenCalledWith({
      runnerId: "runner-offline",
      actorId: "admin-1",
    });
  });
});

function appWith(
  session: { user: { id: string; role: string } } | null,
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
