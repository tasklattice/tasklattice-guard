import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { Registry } from "prom-client";

import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

function setup(enabled: boolean) {
  const config = loadConfig({
    NODE_ENV: "test",
    CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
    CONTROLLER_HTTP_HOST: "127.0.0.1",
    CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
    CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
    CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
    BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
    CONTROLLER_MOCK_SSO_ENABLED: enabled ? "true" : "false",
  });
  const signInUsername = vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { id: "demo-user", tenantId: "tenantA" } }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": "tali-guard.session_token=demo; HttpOnly; SameSite=Lax" },
  }));
  const handler = vi.fn().mockResolvedValue(new Response("ok"));
  const getSession = vi.fn().mockResolvedValue(null);
  const app = createHttpApp({
    config,
    auth: { handler, api: { signInUsername, getSession } } as unknown as ControllerAuth,
    service: {} as ControlPlaneService,
    runnerControl: {} as RunnerControlServer,
    metrics: { registry: new Registry() } as ControllerMetrics,
  });
  return { app, handler, signInUsername, getSession };
}

describe("Mock SSO HTTP boundary", () => {
  it("exposes the opt-in state and passes the fixed identity through Better Auth with its session cookie", async () => {
    const { app, signInUsername } = setup(true);
    expect(await (await app.request("/api/mock-sso/config")).json()).toEqual({ enabled: true });
    const response = await app.request("/api/mock-sso/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:8080" },
      body: JSON.stringify({ identity: "tenantB" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("tali-guard.session_token=demo");
    expect(signInUsername).toHaveBeenCalledWith({ body: { username: "mock-tenantb", password: expect.any(String) }, asResponse: true });
  });

  it("rejects disabled, unknown, and cross-origin sign-in attempts", async () => {
    const disabled = setup(false);
    expect(await (await disabled.app.request("/api/mock-sso/config")).json()).toEqual({ enabled: false });
    expect((await disabled.app.request("/api/mock-sso/sign-in", { method: "POST" })).status).toBe(404);
    expect(disabled.signInUsername).not.toHaveBeenCalled();

    const enabled = setup(true);
    const post = (identity: string, origin: string) => enabled.app.request("/api/mock-sso/sign-in", {
      method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ identity }),
    });
    expect((await post("tenantD", "http://localhost:8080")).status).toBe(400);
    expect((await post("tenantA", "https://attacker.example")).status).toBe(403);
    expect(enabled.signInUsername).not.toHaveBeenCalled();
  });

  it("preserves global user administration for a current platform session", async () => {
    const { app, handler, getSession } = setup(true);
    getSession.mockResolvedValue({ user: { id: "platform", role: "admin", tenantId: "tenantB" } });
    expect((await app.request("/api/auth/admin/list-users")).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledWith(expect.objectContaining({ query: { disableCookieCache: true } }));
  });

  it("rejects tenant and PAT access to global user administration", async () => {
    const { app, handler, getSession } = setup(true);
    getSession.mockResolvedValue({ user: { id: "tenant-a", role: "user", tenantId: "tenantA" } });
    expect((await app.request("/api/auth/admin/create-user", { method: "POST", body: "not-json" })).status).toBe(403);
    getSession.mockResolvedValue({ user: { id: "platform", role: "admin" } });
    expect((await app.request("/api/auth/admin/list-users", { headers: { authorization: "Bearer token" } })).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("blocks Better Auth's global administrator routes before they reach the auth handler", async () => {
    const { app, handler } = setup(true);
    const response = await app.request("/api/auth/admin/list-users", { method: "GET" });
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
});
