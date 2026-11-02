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
  tenantId: "tenantA",
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
  it.each(["f5-scan", "litellm-generic-guardrail"])("uses the incoming origin across all %s setup responses", async (adapter) => {
    const resource = { ...endpoint, adapter, credential: "tg_one_time" };
    const app = appWith({ user: { id: "admin-1", role: "user", tenantId: "tenantA" } }, {
      listEndpoints: vi.fn().mockResolvedValue([resource]),
      getEndpoint: vi.fn().mockResolvedValue(resource),
      createEndpoint: vi.fn().mockResolvedValue(resource),
      updateEndpoint: vi.fn().mockResolvedValue(resource),
      rotateEndpointCredential: vi.fn().mockResolvedValue(resource),
    });
    const requests = [
      { path: "", method: "GET" },
      { path: "/endpoint-1", method: "GET" },
      { path: "", method: "POST", body: JSON.stringify({ name: "New endpoint", adapter }) },
      { path: "/endpoint-1", method: "PATCH", body: JSON.stringify({ enabled: false }) },
      { path: "/endpoint-1/credentials", method: "POST" },
    ];
    for (const request of requests) {
      const response = await app.request(`https://console.example.test:8443/api/v1/endpoints${request.path}`, {
        ...request, headers: { "content-type": "application/json" },
      });
      expect(response.status).toBe(request.method === "POST" ? 201 : 200);
      const body = await response.json();
      const result = body.items?.[0] ?? body;
      expect(result.setup.api_base_url).toBe("https://console.example.test:8443/runtime/v1/endpoints/endpoint-1");
      expect(result.setup.callback_url).toBe(`${result.setup.api_base_url}${adapter === "f5-scan" ? "/backend/v1/scans" : "/beta/litellm_basic_guardrail_api"}`);
      if (adapter === "f5-scan") expect(result.setup.yaml_template).toContain(result.setup.callback_url);
      expect(result.credential).toBe("tg_one_time");
    }
  });

  it("uses the proxy's external origin and preserves an explicit runtime override", async () => {
    const session = { user: { id: "member-1", role: "user", tenantId: "tenantA" } };
    const service = { getEndpoint: vi.fn().mockResolvedValue(endpoint) };
    const headers = { "x-forwarded-host": "guard.example.test:9443", "x-forwarded-proto": "https" };
    for (const runtimePublicUrl of [null, "https://runtime.example.test:8443/guard"]) {
      const app = appWith(session, service, { ...config, runtimePublicUrl });
      const response = await app.request("http://controller.internal:8080/api/v1/endpoints/endpoint-1", { headers });
      expect(response.status).toBe(200);
      expect((await response.json()).setup.api_base_url).toBe(`${runtimePublicUrl ?? "https://guard.example.test:9443"}/runtime/v1/endpoints/endpoint-1`);
    }
  });

  it("retains an explicit false default during creation and updates", async () => {
    const createEndpoint = vi.fn().mockResolvedValue({ ...endpoint, adapter: "f5-scan", scanFlagOnlyDefault: false });
    const updateEndpoint = vi.fn().mockResolvedValue({ ...endpoint, adapter: "f5-scan", scanFlagOnlyDefault: false });
    const app = appWith({ user: { id: "admin-1", role: "user", tenantId: "tenantA" } }, { createEndpoint, updateEndpoint });
    const created = await app.request("/api/v1/endpoints", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Scan", adapter: "f5-scan", scanFlagOnlyDefault: false }),
    });
    expect(created.status).toBe(201);
    expect(createEndpoint).toHaveBeenCalledWith({ name: "Scan", adapter: "f5-scan", scanFlagOnlyDefault: false, actorId: "admin-1" });
    const updated = await app.request("/api/v1/endpoints/endpoint-1", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ scanFlagOnlyDefault: false }),
    });
    expect(updated.status).toBe(200);
    expect(updateEndpoint).toHaveBeenCalledWith({ id: "endpoint-1", scanFlagOnlyDefault: false, actorId: "admin-1" });
  });

  it.each([{}, { scanFlagOnlyDefault: "false" }, { scanFlagOnlyDefault: null }, { scanFlagOnlyDefault: 0 }])("rejects invalid Scan default updates %j", async body => {
    const updateEndpoint = vi.fn();
    const app = appWith({ user: { id: "admin-1", role: "user", tenantId: "tenantA" } }, { updateEndpoint });
    expect((await app.request("/api/v1/endpoints/endpoint-1", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })).status).toBe(400);
    expect(updateEndpoint).not.toHaveBeenCalled();
  });
  it.each(["litellm-generic-guardrail", "f5-scan"])("creates the supported Endpoint adapter %s", async (adapter) => {
    const createEndpoint = vi.fn().mockResolvedValue({ ...endpoint, adapter });
    const app = appWith({ user: { id: "admin-1", role: "user", tenantId: "tenantA" } }, { createEndpoint });
    const response = await app.request("/api/v1/endpoints", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Supported endpoint", adapter }),
    });
    expect(response.status).toBe(201);
    expect(createEndpoint).toHaveBeenCalledExactlyOnceWith({ name: "Supported endpoint", adapter, actorId: "admin-1" });
  });

  it.each(["generic-http-guard", "a2a-guard", "http", "a2a", "scan", "unknown"])("rejects unsupported Endpoint adapter %s before creating anything", async (adapter) => {
    const createEndpoint = vi.fn();
    const app = appWith({ user: { id: "admin-1", role: "user", tenantId: "tenantA" } }, { createEndpoint });
    const response = await app.request("/api/v1/endpoints", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Invalid endpoint", adapter }),
    });
    expect(response.status).toBe(400);
    expect(createEndpoint).not.toHaveBeenCalled();
  });

  it("allows authenticated users to read detail without exposing a digest", async () => {
    const getEndpoint = vi.fn().mockResolvedValue(endpoint);
    const app = appWith({ user: { id: "member-1", role: "user", tenantId: "tenantA" } }, { getEndpoint });

    const response = await app.request("/api/v1/endpoints/endpoint-1");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(getEndpoint).toHaveBeenCalledWith("endpoint-1");
    expect(body).toMatchObject({
      credentials: [{ id: "credential-1", keyHint: "tg_abcd…wxyz" }],
      setup: { callback_url: "http://localhost/runtime/v1/endpoints/endpoint-1/beta/litellm_basic_guardrail_api" },
    });
    expect(JSON.stringify(body)).not.toContain("sha256");
  });

  it("rejects unknown roles before status and credential mutations", async () => {
    const app = appWith({ user: { id: "member-1", role: "unknown", tenantId: "tenantA" } }, {});

    expect((await app.request("/api/v1/endpoints/endpoint-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })).status).toBe(403);
    expect((await app.request("/api/v1/endpoints/endpoint-1", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ scanFlagOnlyDefault: false }),
    })).status).toBe(403);
    expect((await app.request("/api/v1/endpoints/endpoint-1/credentials", {
      method: "POST",
    })).status).toBe(403);
    expect((await app.request("/api/v1/endpoints/endpoint-1/credentials/credential-1", {
      method: "DELETE",
    })).status).toBe(403);
  });

  it.each(["user"])("forwards the %s actor and route parameters to the service", async role => {
    const updateEndpoint = vi.fn().mockResolvedValue({ ...endpoint, status: "disabled" });
    const rotateEndpointCredential = vi.fn().mockResolvedValue({ ...endpoint, credential: "tg_one_time" });
    const revokeEndpointCredential = vi.fn().mockResolvedValue(undefined);
    const getEndpoint = vi.fn().mockResolvedValue(endpoint);
    const app = appWith(
      { user: { id: "admin-1", role, tenantId: "tenantA" } },
      { updateEndpoint, rotateEndpointCredential, revokeEndpointCredential, getEndpoint },
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
    expect(getEndpoint).toHaveBeenCalledWith("endpoint-1");
    expect(updateEndpoint).toHaveBeenCalledWith({ id: "endpoint-1", enabled: false, actorId: "admin-1" });
    expect(rotateEndpointCredential).toHaveBeenCalledWith({ id: "endpoint-1", actorId: "admin-1" });
    expect(revokeEndpointCredential).toHaveBeenCalledWith({
      id: "endpoint-1",
      credentialId: "credential-1",
      actorId: "admin-1",
    });
  });
});

function appWith(
  session: { user: { id: string; role: string; tenantId?: string } } | null,
  service: Partial<ControlPlaneService>,
  appConfig = config,
) {
  const auth = {
    api: { getSession: vi.fn().mockResolvedValue(session) },
    handler: vi.fn(),
  } as unknown as ControllerAuth;
  return createHttpApp({
    config: appConfig,
    auth,
    service: service as ControlPlaneService,
    runnerControl: {
      distributionStatus: vi.fn().mockResolvedValue({ desiredGeneration: 7, distributionStatus: "ready" }),
      distributeDesiredState: vi.fn().mockResolvedValue({ desiredGeneration: 7, distributionStatus: "ready" }),
    } as unknown as RunnerControlServer,
    metrics: {} as ControllerMetrics,
  });
}
