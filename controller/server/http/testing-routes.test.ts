// @vitest-environment node
import { runnerAuthEnv } from "../../test/runner-auth-fixture.js";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";
import { NotFoundError } from "../domain/errors.js";

function setup(role = "user") {
  const run = { id: "run-1", status: "queued" };
  const service = {
    requestValidation: vi.fn().mockResolvedValue(run),
    cancelValidation: vi.fn().mockResolvedValue({ ...run, status: "cancelled" }),
    queryValidationRuns: vi.fn().mockResolvedValue({ items: [run], count: 1 }),
    getValidationRun: vi.fn().mockResolvedValue(run),
    authorizeReportRead: vi.fn().mockResolvedValue(undefined),
    reportResults: { page: vi.fn(), detail: vi.fn() },
    testingReportDeletionImpact: vi.fn().mockResolvedValue({ runId: "run-1", running: false, deletable: true }),
    deleteTestingReport: vi.fn().mockResolvedValue(undefined),
    setTestCaseExcluded: vi.fn().mockResolvedValue({ excludedTestCaseIds: ["policy/case-1"] }),
    requestPolicyValidation: vi.fn().mockResolvedValue(run),
    latestPolicyValidation: vi.fn().mockResolvedValue(run),
    getPolicyValidation: vi.fn().mockResolvedValue(run),
    preparePolicyVersionTest: vi.fn().mockResolvedValue({ policyId: "policy-1", version: "v1", requiredBindings: [], tests: [{ id: "case-1" }] }),
    getPolicy: vi.fn().mockResolvedValue({ id: "policy-1", version: "v1" }),
    policyResources: { validateVersion: vi.fn().mockResolvedValue(run), versionReport: vi.fn().mockResolvedValue(run) },
  };
  const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://test:test@localhost/test",
    ...runnerAuthEnv("runner-token-that-is-at-least-32-characters"), CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem",
    CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
  const distributeDesiredState = vi.fn().mockResolvedValue(undefined);
  const app = createHttpApp({ config,
    auth: { api: { getSession: vi.fn().mockResolvedValue({ session: { id: "fixture-session", activeProjectId: "projectA" }, user: { id: "admin-1", role, projectId: "projectA" } }) } } as unknown as ControllerAuth,
    service: service as unknown as ControlPlaneService,
    runnerControl: { hasDefaultCompiler: () => true, distributeDesiredState } as RunnerControlServer, metrics: {} as ControllerMetrics,
  });
  return { app, service, run, distributeDesiredState };
}

describe("Testing HTTP paths", () => {
  it("starts the exact selected version and disables missing Protection on both readiness and submission", async () => {
    const { app, service } = setup();
    const path = "/api/v1/policies/policy-1/versions/v1";
    expect(await (await app.request(`${path}/test-readiness`)).json()).toMatchObject({ ready: true, total: 1, blockers: [] });
    expect((await app.request(`${path}/test-runs`, { method: "POST" })).status).toBe(202);
    expect(service.preparePolicyVersionTest).toHaveBeenCalledWith("policy-1", "v1");
    expect(service.policyResources.validateVersion).toHaveBeenCalledWith(expect.objectContaining({ version: "v1" }), { poolId: "default", modelRevisionId: "", models: [] }, "admin-1");
    service.preparePolicyVersionTest.mockResolvedValue({ policyId: "policy-1", version: "v1", requiredBindings: ["content_safety.input"], tests: [{ id: "case-1" }] });
    service.policyResources.validateVersion.mockClear();
    expect(await (await app.request(`${path}/test-readiness`)).json()).toMatchObject({ ready: false, blockers: [{ code: "protection_missing", binding: "content_safety.input" }] });
    expect((await app.request(`${path}/test-runs`, { method: "POST" })).status).toBe(409);
    expect(service.policyResources.validateVersion).not.toHaveBeenCalled();
  });

  it("keeps Policy tests read-only for viewers and authorizes full case evidence", async () => {
    const viewer = setup("viewer");
    expect((await viewer.app.request("/api/v1/policies/policy-1/versions/v1/test-runs", { method: "POST" })).status).toBe(403);
    expect(viewer.service.policyResources.validateVersion).not.toHaveBeenCalled();
    const { app, service } = setup();
    service.reportResults.detail.mockResolvedValue({ trace: Array.from({ length: 150 }, (_, index) => ({ index })) });
    const detail = await app.request("/api/v1/test-runs/run-1/cases/7/evidence");
    expect(detail.status).toBe(200);
    expect((await detail.json()).trace).toHaveLength(150);
    expect(service.authorizeReportRead).toHaveBeenCalledWith("run-1");
    expect(service.reportResults.detail).toHaveBeenCalledWith("run-1", 7, 0, true);
    service.authorizeReportRead.mockRejectedValue(new NotFoundError("Testing Report", "run-1"));
    expect((await app.request("/api/v1/test-runs/run-1/cases/7/evidence")).status).toBe(404);
  });

  it("starts and reads a Guardrail Test Run through the renamed routes", async () => {
    const { app, service, run } = setup();
    const created = await app.request("/api/v1/guardrails/guard-1/test-runs", { method: "POST" });
    expect(created.status).toBe(202);
    expect(await created.json()).toEqual(run);
    expect(service.requestValidation).toHaveBeenCalledWith({ guardrailId: "guard-1", actorId: "admin-1", compilerAvailable: true, testModelRules: true });
    const list = await app.request("/api/v1/test-runs?guardrailId=guard-1");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ items: [run], count: 1 });
    expect(service.queryValidationRuns).toHaveBeenCalledWith({ guardrailId: "guard-1", limit: 25, q: "", status: "all" });
    const detail = await app.request("/api/v1/test-runs/run-1");
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(run);
    expect(service.getValidationRun).toHaveBeenCalledWith("run-1");
  });

  it("compresses one bounded case without losing its trace and keeps metadata separate",async()=>{
    const {app,service}=setup();
    const detail={caseId:"one",trace:[{detail:"full evidence ".repeat(10000)}],traceCount:1,nextTraceOffset:null};
    service.reportResults.detail.mockResolvedValue(detail);
    const response=await app.request("/api/v1/test-runs/run-1/cases/7",{headers:{"accept-encoding":"gzip"}});
    expect(response.status).toBe(200);expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString())).toEqual(detail);
    expect(service.reportResults.detail).toHaveBeenCalledWith("run-1",7,0);
    expect(await (await app.request("/api/v1/test-runs/run-1")).json()).not.toHaveProperty("results");
  });

  it.each(["/cases", "/cases/7"])("rejects a hidden report before reading bounded evidence at %s", async suffix => {
    const { app, service } = setup();
    service.authorizeReportRead.mockRejectedValue(new NotFoundError("Testing Report", "private-run"));
    const response = await app.request(`/api/v1/test-runs/private-run${suffix}`);
    expect(response.status).toBe(404);
    expect(service.authorizeReportRead).toHaveBeenCalledExactlyOnceWith("private-run");
    expect(service.reportResults.page).not.toHaveBeenCalled();
    expect(service.reportResults.detail).not.toHaveBeenCalled();
  });

  it("cancels an exact test ID without deleting its report", async () => {
    const { app, service } = setup();
    const response = await app.request("/api/v1/test-runs/run-1/cancel", { method: "POST" });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ id: "run-1", status: "cancelled" });
    expect(service.cancelValidation).toHaveBeenCalledExactlyOnceWith({ runId: "run-1", actorId: "admin-1" });
    expect(service.deleteTestingReport).not.toHaveBeenCalled();
  });

  it("does not let viewers cancel tests", async () => {
    const { app, service } = setup("viewer");
    expect((await app.request("/api/v1/test-runs/run-1/cancel", { method: "POST" })).status).toBe(403);
    expect(service.cancelValidation).not.toHaveBeenCalled();
  });

  it("deletes reports without a compatibility body or Runner synchronization", async () => {
    const { app, service, distributeDesiredState } = setup();
    expect((await app.request("/api/v1/test-runs/run-1/deletion-impact")).status).toBe(200);
    expect((await app.request("/api/v1/test-runs/run-1", { method: "DELETE" })).status).toBe(204);
    expect(service.deleteTestingReport).toHaveBeenCalledWith({ runId: "run-1", actorId: "admin-1" });
    expect(distributeDesiredState).not.toHaveBeenCalled();
  });
  it("does not let viewers delete reports", async () => {
    const { app, service } = setup("viewer");
    expect((await app.request("/api/v1/test-runs/run-1", { method: "DELETE" })).status).toBe(403);
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
    for (const call of Object.values(service).filter(vi.isMockFunction)) expect(call).not.toHaveBeenCalled();
  });
});
