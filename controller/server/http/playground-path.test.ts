import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { loadConfig } from "../config.js";
import { createHttpApp } from "./app.js";
import type { ControllerAuth } from "../auth.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { RunnerPlaygroundClient } from "../playground/service.js";
const config = loadConfig({
  NODE_ENV: "test",
  CONTROLLER_DATABASE_URL: "postgresql://user:pass@localhost/test",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/unused.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve(
    "../runner/toolkit/policy_library/assets",
  ),
  BETTER_AUTH_SECRET: "auth-secret-that-is-at-least-32-characters",
});
function setup(authenticated = true) {
  const router = {
    id: "r1",
    activeRevision: 3,
    draftRevision: 4,
    endpointIds: ["e1"],
    draft: {
      routes: [
        {
          id: "fallback",
          name: "Fallback",
          kind: "fallback",
          enabled: true,
          selector: { expression: { combinator: "and", conditions: [] } },
          targets: [
            {
              id: "t1",
              guardrailId: "g1",
              guardrailVersion: "v1",
              weightBps: 10000,
            },
          ],
        },
      ],
    },
  };
  const testPath = vi.fn().mockResolvedValue({
    status: 200,
    source: "runner",
    body: { runnerId: "r1" },
  });
  const app = createHttpApp({
    config,
    auth: {
      api: {
        getSession: vi
          .fn()
          .mockResolvedValue(
            authenticated ? { user: { id: "user", role: "admin" } } : null,
          ),
      },
      handler: vi.fn(),
    } as unknown as ControllerAuth,
    service: {
      trafficRouting: { get: vi.fn().mockResolvedValue(router) },
      getEndpoint: vi.fn().mockResolvedValue({ id: "e1" }),
    } as unknown as ControlPlaneService,
    runnerControl: {} as RunnerControlServer,
    metrics: {} as ControllerMetrics,
    playgroundRunner: { testPath } as unknown as RunnerPlaygroundClient,
  });
  return {
    testPath,
    send: (extra = {}) =>
      app.request("/api/v1/playground/path-tests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "router",
          targetId: "r1",
          configuration: "published",
          expectedRevision: 3,
          action: "simulate",
          endpointId: "e1",
          callId: "call",
          request: "POST /chat HTTP/1.1\n\nhello",
          ...extra,
        }),
      }),
  };
}
describe("Playground path HTTP boundary", () => {
  it("requires a session and fences stale Router revisions before contacting Runner", async () => {
    expect((await setup(false).send()).status).toBe(401);
    const { send, testPath } = setup();
    expect((await send({ expectedRevision: 2 })).status).toBe(422);
    expect((await send({ endpointId: "other" })).status).toBe(422);
    expect(testPath).not.toHaveBeenCalled();
    expect((await send()).status).toBe(200);
    expect(testPath).toHaveBeenCalledOnce();
  });
  it("simulates draft candidates without executing Runner and rejects draft execution", async () => {
    const { send, testPath } = setup();
    const result = await send({ configuration: "draft", expectedRevision: 4 });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      source: "controller-draft",
      body: { candidates: [{ guardrailId: "g1" }] },
    });
    expect(
      (
        await send({
          configuration: "draft",
          expectedRevision: 4,
          action: "execute",
        })
      ).status,
    ).toBe(422);
    expect(testPath).not.toHaveBeenCalled();
  });
  it("reports invalid request syntax without a server exception", async () => {
    const { send, testPath } = setup();
    expect((await send({ request: "bad HTTP" })).status).toBe(422);
    expect(
      (await send({ request: "POST /chat HTTP/1.1\nHost: [bad\n\nhello" }))
        .status,
    ).toBe(422);
    expect(testPath).not.toHaveBeenCalled();
  });
});
