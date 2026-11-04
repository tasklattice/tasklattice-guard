// @vitest-environment node
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import type { ControllerAuth } from "../auth.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import { RunnerPlaygroundClient } from "../playground/service.js";
import { createHttpApp } from "./app.js";

const legacy = "legacy-controller-token-with-at-least-32-characters";
const controlA = "default-control-token-with-at-least-32-characters";
const controlB = "beta-control-token-with-at-least-32-characters";
const inboundA = "default-inbound-http-token-with-at-least-32-characters";
const inboundB = "beta-inbound-http-token-with-at-least-32-characters";

function setup(poolId: string, scoped = true, runtimeUrlOverride?: string) {
  const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://a:b@localhost/a",
    CONTROLLER_RUNNER_TOKEN: legacy, CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/key",
    CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
    CONTROLLER_RUNTIME_SERVICE_URL: "http://default-runner:8091",
    ...(scoped ? { CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ default: controlA, beta: controlB }),
      CONTROLLER_RUNNER_HTTP_TOKENS_JSON: JSON.stringify({ default: inboundA, beta: inboundB }) } : {}) });
  const runtimeUrl = runtimeUrlOverride ?? (poolId === "default" ? config.runtimeServiceUrl : `http://${poolId}-runner:8091`);
  const fetcher = vi.fn().mockResolvedValue(Response.json({ rules: [], assignment: {}, runnerId: "runner" }));
  const service = { groupRouting: { poolForProject: vi.fn().mockResolvedValue({ poolId, groupId: "group", runtimeUrl, publicUrl: null }) },
    trafficRouting: { get: vi.fn().mockResolvedValue({ id: "router", activeRevision: 1, endpointIds: ["endpoint"] }) } };
  const app = createHttpApp({ config,
    auth: { api: { getSession: vi.fn().mockResolvedValue({ session: { id: "fixture-session", activeProjectId: "projectB" }, user: { id: "user", role: "user", projectId: "projectB" } }) } } as unknown as ControllerAuth,
    service: service as unknown as ControlPlaneService, runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics,
    // A deliberately legacy base client proves pool selection replaces its
    // credentials, including the default pool at the unchanged base URL.
    playgroundRunner: new RunnerPlaygroundClient({ baseUrl: config.runtimeServiceUrl, token: legacy, fetcher }) });
  const request = () => app.request("/api/v1/playground/path-tests", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: "router", targetId: "router", endpointId: "endpoint", expectedRevision: 1,
      callId: "call", configuration: "published", action: "simulate", request: "POST /test HTTP/1.1\n\nhello" }) });
  return { fetcher, request, runtimeUrl };
}

describe("Controller-to-Runner pool HTTP authority", () => {
  it.each([["default", inboundA], ["beta", inboundB]])("selects only %s pool's inbound credential", async (poolId, token) => {
    const { request, fetcher, runtimeUrl } = setup(poolId);
    expect((await request()).status).toBe(200);
    expect(fetcher).toHaveBeenCalledWith(`${runtimeUrl}/internal/v1/playground/routers/router/test`, expect.objectContaining({
      headers: expect.objectContaining({ authorization: `Bearer ${token}` }),
    }));
    const sent = JSON.stringify(fetcher.mock.calls);
    for (const forbidden of [legacy, controlA, controlB, poolId === "default" ? inboundB : inboundA]) expect(sent).not.toContain(forbidden);
  });

  it("fails closed when a dynamically selected pool has no HTTP credential instead of falling back", async () => {
    const { request, fetcher } = setup("missing");
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "runner_http_credential_unavailable" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains explicitly legacy behavior when no HTTP map is configured", async () => {
    const { request, fetcher } = setup("beta", false);
    expect((await request()).status).toBe(200);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: `Bearer ${legacy}` });
  });

  it("does not switch authorities when a pool URL incorrectly points to another pool", async () => {
    const { request, fetcher } = setup("default", true, "http://beta-runner:8091");
    fetcher.mockImplementation(async (_url, init) => init.headers.authorization === `Bearer ${inboundB}`
      ? Response.json({ unexpected: "beta data" }) : Response.json({ detail: "Controller authentication failed." }, { status: 401 }));
    const response = await request();
    expect(response.status).toBe(200); // Path tests return the upstream status as evidence.
    const result = await response.json();
    expect(result.status).toBe(401);
    expect(JSON.stringify(result)).not.toContain("beta data");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: `Bearer ${inboundA}` });
  });
});
