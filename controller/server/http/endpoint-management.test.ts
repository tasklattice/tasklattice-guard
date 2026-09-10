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
  CONTROLLER_RUNTIME_SERVICE_URL: "https://runtime.example.test",
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
});

const endpoint = {
  id: "endpoint-1",
  name: "Primary gateway",
  adapter: "litellm-generic-guardrail",
  status: "active",
  createdAt: new Date("2026-08-20T00:00:00Z"),
  updatedAt: new Date("2026-08-20T00:00:00Z"),
  credentials: [{ id: "credential-1", keyHint: "tg_abcd…wxyz", createdAt: "2026-08-20T00:00:00.000Z" }],
  setup: {
    api_base_url: "https://runtime.example.test/runtime/v1/endpoints/endpoint-1",
    callback_url: "https://runtime.example.test/runtime/v1/endpoints/endpoint-1/beta/litellm_basic_guardrail_api",
  },
};

describe("Endpoint management HTTP routes", () => {
  it("allows authenticated users to read detail without exposing a digest", async () => {
    const getEndpoint = vi.fn().mockResolvedValue(endpoint);
    const app = appWith({ user: { id: "member-1", role: "user" } }, { getEndpoint });

    const response = await app.request("/api/v1/endpoints/endpoint-1");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(getEndpoint).toHaveBeenCalledWith("endpoint-1");
    expect(body).toMatchObject({
      credentials: [{ id: "credential-1", keyHint: "tg_abcd…wxyz" }],
      setup: { callback_url: "https://runtime.example.test/runtime/v1/endpoints/endpoint-1/beta/litellm_basic_guardrail_api" },
    });
    expect(JSON.stringify(body)).not.toContain("sha256");
  });

  it("requires an administrator for status and credential mutations", async () => {
    const app = appWith({ user: { id: "member-1", role: "user" } }, {});

    expect((await app.request("/api/v1/endpoints/endpoint-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })).status).toBe(403);
    expect((await app.request("/api/v1/endpoints/endpoint-1/credentials", {
      method: "POST",
    })).status).toBe(403);
    expect((await app.request("/api/v1/endpoints/endpoint-1/credentials/credential-1", {
      method: "DELETE",
    })).status).toBe(403);
  });

  it("forwards the administrator actor and route parameters to the service", async () => {
    const setEndpointEnabled = vi.fn().mockResolvedValue({ ...endpoint, status: "disabled" });
    const rotateEndpointCredential = vi.fn().mockResolvedValue({ ...endpoint, credential: "tg_one_time" });
    const revokeEndpointCredential = vi.fn().mockResolvedValue(undefined);
    const app = appWith(
      { user: { id: "admin-1", role: "admin" } },
      { setEndpointEnabled, rotateEndpointCredential, revokeEndpointCredential },
    );

    const toggled = await app.request("/api/v1/endpoints/endpoint-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const rotated = await app.request("/api/v1/endpoints/endpoint-1/credentials", { method: "POST" });
    const revoked = await app.request("/api/v1/endpoints/endpoint-1/credentials/credential-1", { method: "DELETE" });

    expect(toggled.status).toBe(200);
    expect(rotated.status).toBe(201);
    expect(revoked.status).toBe(204);
    expect(setEndpointEnabled).toHaveBeenCalledWith({ id: "endpoint-1", enabled: false, actorId: "admin-1" });
    expect(rotateEndpointCredential).toHaveBeenCalledWith({ id: "endpoint-1", actorId: "admin-1" });
    expect(revokeEndpointCredential).toHaveBeenCalledWith({
      id: "endpoint-1",
      credentialId: "credential-1",
      actorId: "admin-1",
    });
  });
});

function appWith(
  session: { user: { id: string; role: string } } | null,
  service: Partial<ControlPlaneService>,
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
      distributeDesiredState: vi.fn().mockResolvedValue({ desiredGeneration: 7, distributionStatus: "ready" }),
    } as unknown as RunnerControlServer,
    metrics: {} as ControllerMetrics,
  });
}
