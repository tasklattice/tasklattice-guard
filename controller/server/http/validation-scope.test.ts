// @vitest-environment node
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { requiredTokenPermission } from "./token-permissions.js";
import { createHttpApp } from "./app.js";

const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://test@localhost/test",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
function setup(role: string | null) {
  const requestValidation = vi.fn().mockResolvedValue({ id: "run" });
  const requestVersionTestRun = vi.fn().mockResolvedValue({ id: "version-run" });
  const auth = { api: { getSession: vi.fn().mockResolvedValue(role ? { session: { id: "fixture-session", activeProjectId: "projectA" }, user: { id: "actor", role, projectId: "projectA" } } : null) } };
  const app = createHttpApp({ config, auth: auth as unknown as ControllerAuth,
    service: { requestValidation, requestVersionTestRun } as unknown as ControlPlaneService,
    runnerControl: { hasDefaultCompiler: () => true } as unknown as RunnerControlServer, metrics: {} as ControllerMetrics });
  return { app, requestValidation, requestVersionTestRun };
}
const draft = "/api/v1/guardrails/guardrail-default/test-runs";
const version = "/api/v1/guardrails/guardrail-default/versions/20261020-090915.265Z/test-runs";
const post = (app: ReturnType<typeof setup>["app"], path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("Unified Default tests", () => {
  it.each([null, "admin", "invalid"])("denies %s without Guardrail authoring authority", async role => {
    const { app, requestValidation, requestVersionTestRun } = setup(role);
    for (const path of [draft, version]) expect((await post(app, path, { testModelRules: false })).status).toBe(role ? 403 : 401);
    expect(requestValidation).not.toHaveBeenCalled(); expect(requestVersionTestRun).not.toHaveBeenCalled();
  });
  it("forwards the frozen scope through ordinary test endpoints", async () => {
    const { app, requestValidation, requestVersionTestRun } = setup("user");
    expect((await post(app, draft, { testModelRules: false })).status).toBe(202);
    expect(requestValidation).toHaveBeenCalledWith({ guardrailId: "guardrail-default", actorId: "actor", compilerAvailable: true, testModelRules: false });
    expect((await post(app, version, {})).status).toBe(202);
    expect(requestVersionTestRun).toHaveBeenCalledWith({ guardrailId: "guardrail-default", version: "20261020-090915.265Z", actorId: "actor", testModelRules: true });
    expect((await post(app, draft, { testModelRules: "false" })).status).toBe(400);
    expect((await post(app, draft, { testModelRules: false, actorId: "other" })).status).toBe(400);
  });
  it("removes both waiver entry points and retains ordinary project testing", async () => {
    const { app } = setup("user");
    for (const path of ["/api/v1/system/default-guardrail/candidates", "/api/v1/system/default-guardrail/versions/20261020-090915.265Z/test-waivers"]) {
      expect(requiredTokenPermission("POST", path)).toBeUndefined();
      expect((await post(app, path, {})).status).toBe(404);
    }
    const project = setup("user");
    expect((await post(project.app, "/api/v1/guardrails/project/test-runs", { testModelRules: false })).status).toBe(202);
    expect(requiredTokenPermission("POST", draft)?.slice(2)).toEqual(["guardrails", "write"]);
  });
});
