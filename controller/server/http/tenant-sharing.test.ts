// @vitest-environment node
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { ControllerMetrics } from "../metrics.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { currentTenantId } from "../services/tenant-context.js";
import type { TenantShareService } from "../services/tenant-shares.js";
import type { AccessTokenService } from "../services/access-tokens.js";
import { createHttpApp } from "./app.js";

const config = loadConfig({
  NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
});

function setup(tenantId?: string, role = "user") {
  const getSession = vi.fn().mockResolvedValue({ user: { id: "actor-b", role, tenantId } });
  const listShares = vi.fn(async () => [{ id: "grant", tenantId: currentTenantId() }]);
  const createShare = vi.fn(async () => ({ id: "grant", tenantId: currentTenantId() }));
  const revokeShare = vi.fn(async () => undefined);
  const shares = { listShares, createShare, revokeShare } as unknown as TenantShareService;
  const service = { updateRunnerPool: vi.fn() } as unknown as ControlPlaneService;
  const app = createHttpApp({
    config, auth: { api: { getSession } } as unknown as ControllerAuth,
    accessTokens: {} as AccessTokenService, tenantShares: shares,
    service, runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics,
  });
  return { app, getSession, listShares, createShare, revokeShare, service };
}

describe("tenant share HTTP boundary", () => {
  it("uses the authenticated tenant for share reads and writes", async () => {
    const { app, createShare } = setup("tenantB");
    const list = await app.request("/api/v1/account/shares");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: [{ tenantId: "tenantB" }] });
    const create = await app.request("/api/v1/account/shares", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceType: "guardrail", resourceId: "guard", recipientTenantId: "tenantC" }),
    });
    expect(create.status).toBe(201);
    expect(createShare).toHaveBeenCalledWith({ resourceType: "guardrail", resourceId: "guard", recipientTenantId: "tenantC" }, "actor-b");
    expect(await create.json()).toMatchObject({ share: { tenantId: "tenantB" } });
  });

  it.each([undefined, "", " ", " tenantA"])("fails closed when the persisted session tenant is %j", async tenantId => {
    const { app, listShares } = setup(tenantId);
    expect((await app.request("/api/v1/account/shares")).status).toBe(401);
    expect(listShares).not.toHaveBeenCalled();
  });

  it("ignores tenant and role headers when the current session has no tenant", async () => {
    const { app, listShares } = setup();
    const response = await app.request("/api/v1/account/shares", { headers: { "x-tenant-id": "tenantB", "x-role": "admin" } });
    expect(response.status).toBe(401);
    expect(listShares).not.toHaveBeenCalled();
  });

  it.each([null, undefined, "viewer"])("fails closed when the persisted session role is %j", async role => {
    const { app, getSession, listShares } = setup("tenantB");
    getSession.mockResolvedValue({ user: { id: "actor-b", role, tenantId: "tenantB" } });
    expect((await app.request("/api/v1/account/shares", { headers: { "x-role": "user" } })).status).toBe(403);
    expect(listShares).not.toHaveBeenCalled();
  });

  it("does not let platform administrators create tenant shares", async () => {
    const { app, createShare } = setup("tenantA", "admin");
    const response = await app.request("/api/v1/account/shares", { method: "POST", headers: { "content-type": "application/json" }, body: "not-json" });
    expect(response.status).toBe(403);
    expect(createShare).not.toHaveBeenCalled();
  });

  it("does not offer global providers as tenant-owned shareable resources", async () => {
    const { app, createShare } = setup("tenantA");
    const response = await app.request("/api/v1/account/shares", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resourceType: "model_provider", resourceId: "provider", recipientTenantId: "tenantB" }) });
    expect(response.status).toBe(400);
    expect(createShare).not.toHaveBeenCalled();
  });

  it("prevents tenant users from changing deployment-wide Runner pools", async () => {
    const { app, service } = setup("tenantB");
    vi.mocked(service.updateRunnerPool).mockResolvedValue({ id: "default" } as Awaited<ReturnType<ControlPlaneService["updateRunnerPool"]>>);
    const targets = { desiredReplicas: 2, safeRpsPerRunner: 50, maxConcurrencyPerRunner: 64 };
    const response = await app.request("/api/v1/runner-pools/default", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(targets) });
    expect(response.status).toBe(403);
    expect(vi.mocked(service.updateRunnerPool)).not.toHaveBeenCalled();
  });
});
