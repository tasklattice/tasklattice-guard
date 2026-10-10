// @vitest-environment node
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

function setup(role = "admin") {
  const run = { id: "run-1", status: "queued" };
  const service = {
    requestValidation: vi.fn().mockResolvedValue(run),
    listValidationRuns: vi.fn().mockResolvedValue([run]),
    getValidationRun: vi.fn().mockResolvedValue(run),
    testingReportDeletionImpact: vi.fn().mockResolvedValue({ runId: "run-1", pendingVersion: "version-1", deletable: true }),
    deleteTestingReport: vi.fn().mockResolvedValue(undefined),
    setTestCaseExcluded: vi.fn().mockResolvedValue({ excludedTestCaseIds: ["policy/case-1"] }),
    requestPolicyValidation: vi.fn().mockResolvedValue(run),
    latestPolicyValidation: vi.fn().mockResolvedValue(run),
    getPolicyValidation: vi.fn().mockResolvedValue(run),
  };
  const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://test:test@localhost/test",
    CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem",
    CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
  const app = createHttpApp({ config,
    auth: { api: { getSession: vi.fn().mockResolvedValue({ user: { id: "admin-1", role } }) } } as unknown as ControllerAuth,
    service: service as unknown as ControlPlaneService,
    runnerControl: { hasDefaultCompiler: () => true, distributeDesiredState: vi.fn().mockResolvedValue(undefined) } as RunnerControlServer, metrics: {} as ControllerMetrics,
  });
  return { app, service, run };
}

describe("Testing HTTP paths", () => {
  it("starts and reads a Guardrail Test Run through the renamed routes", async () => {
    const { app, service, run } = setup();
    const created = await app.request("/api/v1/guardrails/guard-1/test-runs", { method: "POST" });
    expect(created.status).toBe(202);
    expect(await created.json()).toEqual(run);
    expect(service.requestValidation).toHaveBeenCalledWith({ guardrailId: "guard-1", actorId: "admin-1", compilerAvailable: true });
    const list = await app.request("/api/v1/test-runs?guardrailId=guard-1");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ items: [run], count: 1 });
    expect(service.listValidationRuns).toHaveBeenCalledWith("guard-1");
    const detail = await app.request("/api/v1/test-runs/run-1");
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(run);
    expect(service.getValidationRun).toHaveBeenCalledWith("run-1");
  });

  it("reviews report deletion and requires the confirmed impact", async () => {
    const { app, service } = setup();
    expect((await app.request("/api/v1/test-runs/run-1/deletion-impact")).status).toBe(200);
    const options = { method: "DELETE", headers: { "content-type": "application/json" } };
    expect((await app.request("/api/v1/test-runs/run-1", { ...options, body: "{}" })).status).toBe(400);
    expect(service.deleteTestingReport).not.toHaveBeenCalled();
    expect((await app.request("/api/v1/test-runs/run-1", { ...options, body: JSON.stringify({ expectedPendingVersion: "version-1" }) })).status).toBe(204);
    expect(service.deleteTestingReport).toHaveBeenCalledWith({ runId: "run-1", actorId: "admin-1", expectedPendingVersion: "version-1" });
  });
  it("does not let viewers delete reports", async () => {
    const { app, service } = setup("viewer");
    expect((await app.request("/api/v1/test-runs/run-1", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedPendingVersion: null }) })).status).toBe(403);
    expect(service.deleteTestingReport).not.toHaveBeenCalled();
  });

  it("updates the test scope without changing exclusion behavior", async () => {
    const { app, service } = setup();
    const response = await app.request("/api/v1/guardrails/guard-1/test-scope", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseId: "policy/case-1", excluded: true }),
    });
    expect(response.status).toBe(200);
    expect(service.setTestCaseExcluded).toHaveBeenCalledWith({ guardrailId: "guard-1", caseId: "policy/case-1", excluded: true, actorId: "admin-1" });
  });

  it("returns a new Policy Test Run URL that can be polled", async () => {
    const { app, service } = setup();
    const response = await app.request("/api/v1/policies/policy-1/test-runs", { method: "POST" });
    expect(response.status).toBe(202);
    const url = "/api/v1/policies/policy-1/test-runs/run-1";
    expect(response.headers.get("Location")).toBe(url);
    expect(await response.json()).toMatchObject({ statusUrl: url });
    expect((await app.request(url)).status).toBe(200);
    expect(service.getPolicyValidation).toHaveBeenCalledWith("policy-1", "run-1");
    expect((await app.request("/api/v1/policies/policy-1/test-runs/latest")).status).toBe(200);
    expect(service.latestPolicyValidation).toHaveBeenCalledWith("policy-1");
  });

  it.each([
    ["GET", "/api/v1/validation-runs"], ["GET", "/api/v1/validation-runs/run-1"],
    ["POST", "/api/v1/guardrails/guard-1/validation-runs"], ["PATCH", "/api/v1/guardrails/guard-1/validation-scope"],
    ["POST", "/api/v1/policies/policy-1/validation-runs"], ["GET", "/api/v1/policies/policy-1/validation-runs/run-1"],
    ["GET", "/api/v1/policies/policy-1/validation-runs/latest"],
  ])("removes %s %s without forwarding to the new API", async (method, path) => {
    const { app, service } = setup();
    const response = await app.request(path, { method });
    expect(response.status).toBe(404);
    for (const call of Object.values(service)) expect(call).not.toHaveBeenCalled();
  });
});
