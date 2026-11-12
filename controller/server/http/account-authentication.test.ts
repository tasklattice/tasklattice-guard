import { runnerAuthEnv } from "../../test/runner-auth-fixture.js";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { Registry } from "prom-client";

import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

function setup() {
  const config = loadConfig({
    NODE_ENV: "test",
    CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
    CONTROLLER_HTTP_HOST: "127.0.0.1",
    ...runnerAuthEnv("runner-token-that-is-at-least-32-characters"),
    CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
    CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
    BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
  });
  const handler = vi.fn().mockResolvedValue(new Response("ok"));
  const getSession = vi.fn().mockResolvedValue(null);
  const app = createHttpApp({
    config,
    auth: { handler, api: { getSession } } as unknown as ControllerAuth,
    service: {} as ControlPlaneService,
    runnerControl: {} as RunnerControlServer,
    metrics: { registry: new Registry() } as ControllerMetrics,
  });
  return { app, handler, getSession };
}

describe("Account authentication HTTP boundaries", () => {
  it.each([
    ["GET", "/api/mock-sso/config"],
    ["POST", "/api/mock-sso/sign-in"],
  ])("does not expose the removed demo endpoint: %s %s", async (method, path) => {
    const { app, handler, getSession } = setup();
    const response = await app.request(path, {
      method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "projectA" }) } : {}),
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(handler).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("preserves global user administration for a current platform session", async () => {
    const { app, handler, getSession } = setup();
    getSession.mockResolvedValue({ session: { id: "fixture-session", activeProjectId: "projectB" }, user: { id: "platform", role: "admin", projectId: "projectB" } });
    expect((await app.request("/api/auth/admin/list-users")).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledWith(expect.objectContaining({ query: { disableCookieCache: true } }));
  });

  it("rejects project and PAT access to global user administration", async () => {
    const { app, handler, getSession } = setup();
    getSession.mockResolvedValue({ session: { id: "fixture-session", activeProjectId: "projectA" }, user: { id: "project-a", role: "user", projectId: "projectA" } });
    expect((await app.request("/api/auth/admin/create-user", { method: "POST", body: "not-json" })).status).toBe(403);
    getSession.mockResolvedValue({ user: { id: "platform", role: "admin" } });
    expect((await app.request("/api/auth/admin/list-users", { headers: { authorization: "Bearer token" } })).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("blocks Better Auth's global administrator routes before they reach the auth handler", async () => {
    const { app, handler } = setup();
    const response = await app.request("/api/auth/admin/list-users", { method: "GET" });
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
});
