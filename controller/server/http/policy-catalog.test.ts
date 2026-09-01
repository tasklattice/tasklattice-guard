import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { NotFoundError } from "../domain/errors.js";
import { createHttpApp } from "./app.js";

const config = loadConfig({
  NODE_ENV: "test",
  CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
});

describe("Policy catalog HTTP compatibility", () => {
  it("requires an authenticated Controller session", async () => {
    const app = appWithSession(null);
    const response = await app.request("/api/v1/policies");

    expect(response.status).toBe(401);
  });

  it("serves the normalized collection and a Policy detail", async () => {
    const app = appWithSession({ user: { id: "member-1", role: "user" } });
    const listResponse = await app.request("/api/v1/policies");
    const collection = await listResponse.json() as { count: number; items: Array<{ id: string; test_count: number }> };

    expect(listResponse.status).toBe(200);
    expect(collection.count).toBe(38);
    expect(collection.items).toHaveLength(38);
    expect(collection.items.find((item) => item.id === "pattern-matching")?.test_count).toBeGreaterThan(0);

    const detailResponse = await app.request("/api/v1/policies/pattern-matching");
    const detail = await detailResponse.json() as { id: string; implementation: string; tags: Array<{ id: string }> };
    expect(detailResponse.status).toBe(200);
    expect(detail).toMatchObject({ id: "pattern-matching", implementation: "rules" });
    expect(detail.tags).toEqual(expect.arrayContaining([expect.objectContaining({ id: "framework:owasp-llm-2025" })]));
  });

  it("returns the standard not-found envelope and the Runner action catalog", async () => {
    const app = appWithSession({ user: { id: "member-1", role: "user" } });
    const missing = await app.request("/api/v1/policies/not-a-policy");
    const actions = await app.request("/api/v1/actions");

    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "not_found" } });
    expect(actions.status).toBe(200);
    await expect(actions.json()).resolves.toMatchObject({
      count: 12,
      items: expect.arrayContaining([
        expect.objectContaining({ name: "GuardEvaluateAction", network_access: true, timeout_ms: 30_000 }),
        expect.objectContaining({ name: "GuardEvaluateAction", version: "1.0.0", supported_rails: ["input", "output"] }),
        expect.objectContaining({ name: "GuardGroundingAction", network_access: true }),
        expect.objectContaining({ name: "GuardReasoningAction", timeout_ms: 30_000 }),
      ]),
    });
  });
});

function appWithSession(session: { user: { id: string; role: string } } | null) {
  const auth = {
    api: { getSession: vi.fn().mockResolvedValue(session) },
    handler: vi.fn(),
  } as unknown as ControllerAuth;
  const policies = PolicyCatalog.load(config.policyCatalogDir);
  const service = {
    listPolicies: vi.fn().mockResolvedValue(policies.list()),
    getPolicy: vi.fn(async (id: string) => {
      const item = policies.get(id);
      if (!item) throw new NotFoundError("Policy", id);
      return item;
    }),
  } as unknown as ControlPlaneService;
  return createHttpApp({
    config,
    auth,
    service,
    runnerControl: {} as RunnerControlServer,
    metrics: {} as ControllerMetrics,
  });
}
