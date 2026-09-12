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
  it("validates and forwards the requested publication revision", async () => {
    const publishPolicy = vi.fn().mockResolvedValue({ version: "1" });
    const app = appWithSession({ user: { id: "author", role: "admin" } }, { publishPolicy });
    const response = await app.request("/api/v1/policies/example/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedDraftRevision: 7 }) });
    expect(response.status).toBe(201);
    expect(publishPolicy).toHaveBeenCalledWith({ id: "example", actorId: "author", expectedDraftRevision: 7 });
    for (const revision of [0, -1, 1.5, "7"]) {
      const invalid = await app.request("/api/v1/policies/example/publish", { method: "POST", body: JSON.stringify({ expectedDraftRevision: revision }) });
      expect(invalid.status).toBe(400);
    }
    expect(publishPolicy).toHaveBeenCalledTimes(1);
  });
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
    expect(collection.count).toBe(69);
    expect(collection.items).toHaveLength(69);
    expect(collection.items.find((item) => item.id === "pattern-matching")?.test_count).toBeGreaterThan(0);

    const detailResponse = await app.request("/api/v1/policies/pattern-matching");
    const detail = await detailResponse.json() as { id: string; implementation: string; tags: Array<{ id: string }> };
    expect(detailResponse.status).toBe(200);
    expect(detail).toMatchObject({ id: "pattern-matching", implementation: "rules" });
    expect(detail.tags).toEqual(expect.arrayContaining([expect.objectContaining({ id: "framework:owasp-llm-2025" })]));
  });

  it("provides authenticated preset previews with pinned ordinary Policy bindings", async () => {
    expect((await appWithSession(null).request("/api/v1/policy-catalog/protection-presets")).status).toBe(401);
    const response = await appWithSession({ user: { id: "member-1", role: "user" } }).request("/api/v1/policy-catalog/protection-presets");
    expect(response.status).toBe(200);
    const data = await response.json() as { directories: unknown[]; items: Array<{ id: string; policies: unknown[]; policyBindings: Array<{ policyId: string; policyVersion: string }> }> };
    expect(data.directories).toHaveLength(8);
    expect(data.items).toHaveLength(5);
    for (const preset of data.items) {
      expect(preset.policyBindings).toHaveLength(preset.policies.length);
      expect(preset.policyBindings.every((binding) => binding.policyVersion.length > 0)).toBe(true);
    }
  });

  it("returns the standard not-found envelope and the Runner action catalog", async () => {
    const app = appWithSession({ user: { id: "member-1", role: "user" } });
    const missing = await app.request("/api/v1/policies/not-a-policy");
    const actions = await app.request("/api/v1/policy-catalog/actions");

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

function appWithSession(session: { user: { id: string; role: string } } | null, overrides: Partial<ControlPlaneService> = {}) {
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
    ...overrides,
  } as unknown as ControlPlaneService;
  return createHttpApp({
    config,
    auth,
    service,
    runnerControl: {} as RunnerControlServer,
    metrics: {} as ControllerMetrics,
  });
}
