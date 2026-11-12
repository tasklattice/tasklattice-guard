import { runnerAuthEnv } from "../../test/runner-auth-fixture.js";
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
  ...runnerAuthEnv("runner-token-that-is-at-least-32-characters"),
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
});

describe("Router management HTTP routes", () => {
  it("rejects an unknown role before deleting a Router", async () => {
    const app = appWith({ session: { id: "fixture-session", activeProjectId: "projectA" }, user: { id: "member-1", role: "unknown", projectId: "projectA" } }, {});

    expect((await app.request("/api/v1/routers/router-1", {
      method: "DELETE",
    })).status).toBe(403);
  });

  it.each(["user"])("lets %s remove an unbound Router and distribute the new desired state", async role => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const distributeDesiredState = vi.fn().mockResolvedValue({ desiredGeneration: 8, distributionStatus: "ready" });
    const app = appWith(
      { session: { id: "fixture-session", activeProjectId: "projectA" }, user: { id: "admin-1", role, projectId: "projectA" } },
      { trafficRouting: { remove } },
      distributeDesiredState,
    );

    const deleted = await app.request("/api/v1/routers/router-1", {
      method: "DELETE",
    });

    expect(deleted.status).toBe(204);
    expect(remove).toHaveBeenCalledWith("router-1", "admin-1");
    expect(distributeDesiredState).toHaveBeenCalledOnce();
  });
});

function appWith(
  session: { user: { id: string; role: string; projectId?: string } } | null,
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
