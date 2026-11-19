// @vitest-environment node
import { runnerAuthEnv } from "../../test/runner-auth-fixture.js";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "./app.js";
import { loadConfig } from "../config.js";
import type { ControllerAuth } from "../auth.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller", ...runnerAuthEnv("runner-token-that-is-at-least-32-characters"), CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem", CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
function setup(authenticated = true) {
  const listAuditEvents = vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 25, before: "2026-09-29T00:00:00.000Z", facets: { kinds: [], resourceTypes: [] } });
  const app = createHttpApp({ config, auth: { api: { getSession: vi.fn().mockResolvedValue(authenticated ? { session: { id: "fixture-session", activeProjectId: "projectA" }, user: { id: "admin", role: "admin", projectId: "projectA" } } : null) }, handler: vi.fn() } as unknown as ControllerAuth, service: { listAuditEvents } as unknown as ControlPlaneService, runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics });
  return { app, listAuditEvents };
}
describe("audit query HTTP contract", () => {
  it("forwards validated filters and pagination", async () => {
    const { app, listAuditEvents } = setup();
    const response = await app.request("/api/v1/audit-events?q=older&actor=human&window=all&page=4&limit=50&kind=policy.updated&resourceType=policy");
    expect(response.status).toBe(200);
    expect(listAuditEvents).toHaveBeenCalledWith(expect.objectContaining({ q: "older", actor: "human", window: "all", page: 4, limit: 50, kind: "policy.updated", resourceType: "policy" }));
    expect(await response.json()).toMatchObject({ total: 0, facets: { kinds: [] } });
  });
  it("rejects invalid filters before querying", async () => {
    const { app, listAuditEvents } = setup();
    expect((await app.request("/api/v1/audit-events?page=0")).status).toBe(400);
    expect(listAuditEvents).not.toHaveBeenCalled();
  });
  it("keeps the audit endpoint authenticated", async () => {
    const { app, listAuditEvents } = setup(false);
    expect((await app.request("/api/v1/audit-events")).status).toBe(401);
    expect(listAuditEvents).not.toHaveBeenCalled();
  });
});
