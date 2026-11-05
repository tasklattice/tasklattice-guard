// @vitest-environment node
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { ControllerMetrics } from "../metrics.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { currentProjectId } from "../services/project-context.js";
import type { ProjectShareService } from "../services/project-shares.js";
import type { AccessTokenService } from "../services/access-tokens.js";
import { createHttpApp } from "./app.js";

const config = loadConfig({
  NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
});

function setup(projectId?: string, role = "user") {
  const getSession = vi.fn().mockResolvedValue({ session: { id: "fixture-session", activeProjectId: projectId }, user: { id: "actor-b", role, projectId } });
  const listShares = vi.fn(async () => [{ id: "grant", projectId: currentProjectId() }]);
  const createShare = vi.fn(async () => ({ id: "grant", projectId: currentProjectId() }));
  const revokeShare = vi.fn(async () => undefined);
  const shares = { listShares, createShare, revokeShare } as unknown as ProjectShareService;
  const service = { updateRunnerPool: vi.fn() } as unknown as ControlPlaneService;
  const app = createHttpApp({
    config, auth: { api: { getSession } } as unknown as ControllerAuth,
    accessTokens: {} as AccessTokenService, projectShares: shares,
    service, runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics,
  });
  return { app, getSession, listShares, createShare, revokeShare, service };
}

describe("project share HTTP boundary", () => {
  it("uses the authenticated project for share reads and writes", async () => {
    const { app, createShare } = setup("projectB");
    const list = await app.request("/api/v1/account/shares");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: [{ projectId: "projectB" }] });
    const create = await app.request("/api/v1/account/shares", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceType: "router", resourceId: "router", recipientProjectId: "projectC" }),
    });
    expect(create.status).toBe(201);
    expect(createShare).toHaveBeenCalledWith({ resourceType: "router", resourceId: "router", recipientProjectId: "projectC" }, "actor-b");
    expect(await create.json()).toMatchObject({ share: { projectId: "projectB" } });
    const guardrail = await app.request("/api/v1/account/shares", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceType: "guardrail", resourceId: "guard", recipientProjectId: "projectC" }),
    });
    expect(guardrail.status).toBe(400);
  });

  it.each([undefined, "", " ", " projectA"])("fails closed when the persisted session project is %j", async projectId => {
    const { app, listShares } = setup(projectId);
    expect((await app.request("/api/v1/account/shares")).status).toBe(403);
    expect(listShares).not.toHaveBeenCalled();
  });

  it("ignores project and role headers when the current session has no project", async () => {
    const { app, listShares } = setup();
    const response = await app.request("/api/v1/account/shares", { headers: { "x-project-id": "projectB", "x-role": "admin" } });
    expect(response.status).toBe(409);
    expect(listShares).not.toHaveBeenCalled();
  });

  it.each([null, undefined, "viewer"])("fails closed when the persisted session role is %j", async role => {
    const { app, getSession, listShares } = setup("projectB");
    getSession.mockResolvedValue({ session: { id: "fixture-session", activeProjectId: "projectB" }, user: { id: "actor-b", role, projectId: "projectB" } });
    expect((await app.request("/api/v1/account/shares", { headers: { "x-role": "user" } })).status).toBe(403);
    expect(listShares).not.toHaveBeenCalled();
  });

  it("does not let platform administrators create project shares", async () => {
    const { app, createShare } = setup("projectA", "admin");
    const response = await app.request("/api/v1/account/shares", { method: "POST", headers: { "content-type": "application/json" }, body: "not-json" });
    expect(response.status).toBe(403);
    expect(createShare).not.toHaveBeenCalled();
  });

  it("does not offer global providers as project-owned shareable resources", async () => {
    const { app, createShare } = setup("projectA");
    const response = await app.request("/api/v1/account/shares", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resourceType: "model_provider", resourceId: "provider", recipientProjectId: "projectB" }) });
    expect(response.status).toBe(400);
    expect(createShare).not.toHaveBeenCalled();
  });

  it("prevents project users from changing deployment-wide Runner pools", async () => {
    const { app, service } = setup("projectB");
    vi.mocked(service.updateRunnerPool).mockResolvedValue({ id: "default" } as Awaited<ReturnType<ControlPlaneService["updateRunnerPool"]>>);
    const targets = { desiredReplicas: 2, safeRpsPerRunner: 50, maxConcurrencyPerRunner: 64 };
    const response = await app.request("/api/v1/runner-pools/default", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(targets) });
    expect(response.status).toBe(403);
    expect(vi.mocked(service.updateRunnerPool)).not.toHaveBeenCalled();
  });
});
