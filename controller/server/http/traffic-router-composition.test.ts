// @vitest-environment node
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { ConflictError, ValidationError } from "../domain/errors.js";
import { routerDraftSchema, type RouterDraft } from "../../shared/traffic-routing.js";
import { createHttpApp } from "./app.js";

const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
export const fallbackDraft = (): RouterDraft => ({ routes: [{ id: "fallback", name: "Fallback", kind: "fallback", enabled: true,
  selector: { expression: { combinator: "and", conditions: [] } }, targets: [{ id: "target", guardrailId: "guard", guardrailVersion: "1", weightBps: 10000 }] }] });
export function setupRoutingHttp(role: string | null = "admin") {
  const router = { id: "router", draft: fallbackDraft(), draftRevision: 1, activeRevision: 1 };
  const trafficRouting = { list: vi.fn().mockResolvedValue([router]), get: vi.fn().mockResolvedValue(router), create: vi.fn().mockResolvedValue(router),
    save: vi.fn().mockResolvedValue(router), rename: vi.fn().mockResolvedValue(router), publish: vi.fn().mockResolvedValue(router), bind: vi.fn().mockResolvedValue(router),
    remove: vi.fn().mockResolvedValue(undefined), revisions: vi.fn().mockResolvedValue([]), distribution: vi.fn().mockResolvedValue({ total: 0, rows: [], telemetryFresh: false }) };
  const duplicateGuardrail = vi.fn().mockResolvedValue({ id: "copy", status: "draft" });
  const listEndpoints = vi.fn().mockResolvedValue([{ id: "http", adapter: "HTTP" }, { id: "a2a", adapter: "A2A" }]);
  const distributeDesiredState = vi.fn().mockResolvedValue({ desiredGeneration: 2, distributionStatus: "pending" });
  const app = createHttpApp({ config, auth: { api: { getSession: vi.fn().mockResolvedValue(role === null ? null : { user: { id: "actor", role } }) }, handler: vi.fn() } as unknown as ControllerAuth,
    service: { trafficRouting, duplicateGuardrail, listEndpoints } as unknown as ControlPlaneService,
    runnerControl: { distributeDesiredState } as unknown as RunnerControlServer, metrics: {} as ControllerMetrics });
  const send = (method: string, path: string, body?: unknown) => app.request(`/api/v1${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, send, trafficRouting, duplicateGuardrail, distributeDesiredState, listEndpoints };
}

describe("Composed Router HTTP contract", () => {
  it.each(["/routers", "/routers/router", "/routers/router/revisions", "/routers/router/distribution", "/routers/router/routes/fallback/distribution", "/traffic-selector-fields"])("requires authentication but allows viewer reads: %s", async path => {
    expect((await setupRoutingHttp(null).send("GET", path)).status).toBe(401);
    expect((await setupRoutingHttp("user").send("GET", path)).status).toBe(200);
  });
  it("forwards complete drafts with actor and optimistic revision, without distributing drafts", async () => {
    const { send, trafficRouting, distributeDesiredState } = setupRoutingHttp(); const draft = fallbackDraft();
    expect((await send("POST", "/routers", { name: " New ", endpointIds: ["http", "a2a"], draft })).status).toBe(201);
    expect(trafficRouting.create).toHaveBeenCalledExactlyOnceWith("New", "", routerDraftSchema.parse(draft), "actor", ["http", "a2a"]);
    expect((await send("PUT", "/routers/router/draft", { expectedDraftRevision: 7, draft })).status).toBe(200);
    expect(trafficRouting.save).toHaveBeenCalledExactlyOnceWith("router", 7, routerDraftSchema.parse(draft), "actor");
    expect((await send("PATCH", "/routers/router", { name: "Renamed", description: "Shared" })).status).toBe(200);
    expect(trafficRouting.rename).toHaveBeenCalledExactlyOnceWith("router", "Renamed", "Shared", "actor");
    expect(distributeDesiredState).not.toHaveBeenCalled();
  });
  it.each([false, true])("publishes and distributes complete state with 202 (rollback=%s)", async rollback => {
    const { send, trafficRouting, distributeDesiredState } = setupRoutingHttp();
    const response = await send("POST", `/routers/router/${rollback ? "rollback" : "publish"}`, { expectedDraftRevision: 7, idempotencyKey: "request", ...(rollback ? { revision: 2 } : {}) });
    expect(response.status).toBe(202);
    expect(trafficRouting.publish).toHaveBeenCalledExactlyOnceWith("router", 7, "request", "actor", ...(rollback ? [2] : []));
    expect(distributeDesiredState).toHaveBeenCalledOnce();
    expect(trafficRouting.publish.mock.invocationCallOrder[0]!).toBeLessThan(distributeDesiredState.mock.invocationCallOrder[0]!);
  });
  it("passes endpoint binding and Duplicate identities through the admin boundary", async () => {
    const { send, trafficRouting, duplicateGuardrail, distributeDesiredState } = setupRoutingHttp();
    expect((await send("PUT", "/routers/router/endpoints", { endpointIds: ["http", "a2a"] })).status).toBe(200);
    expect(trafficRouting.bind).toHaveBeenCalledExactlyOnceWith("router", ["http", "a2a"], "actor");
    expect(distributeDesiredState).toHaveBeenCalledOnce();
    const request = { name: "Copy", sourceDraftRevision: 3, idempotencyKey: "copy-request" };
    expect((await send("POST", "/guardrails/guard/duplicate", request)).status).toBe(201);
    expect(duplicateGuardrail).toHaveBeenCalledExactlyOnceWith({ ...request, id: "guard", actorId: "actor" });
  });
  it.each([
    ["POST", "/routers", { name: "", draft: fallbackDraft() }],
    ["PUT", "/routers/router/draft", { expectedDraftRevision: 0, draft: fallbackDraft() }],
    ["PUT", "/routers/router/draft", { expectedDraftRevision: 1, draft: { routes: [] } }],
    ["POST", "/routers/router/publish", { expectedDraftRevision: 1 }],
    ["POST", "/routers/router/publish", { expectedDraftRevision: 1.5, idempotencyKey: "x" }],
    ["POST", "/routers/router/rollback", { expectedDraftRevision: 1, idempotencyKey: "x", revision: 0 }],
    ["PUT", "/routers/router/endpoints", { endpointIds: [""] }],
    ["POST", "/guardrails/guard/duplicate", { name: "Copy", sourceVersion: "1", sourceDraftRevision: 1, idempotencyKey: "x" }],
    ["GET", "/routers/router/distribution?hours=169", undefined],
    ["GET", "/routers/router/distribution?revision=0", undefined],
  ])("rejects malformed %s %s before service writes", async (method, path, body) => {
    const { send, trafficRouting, duplicateGuardrail, distributeDesiredState } = setupRoutingHttp();
    expect((await send(method as string, path as string, body)).status).toBe(400);
    for (const method of [trafficRouting.create, trafficRouting.save, trafficRouting.publish, trafficRouting.bind, trafficRouting.distribution, duplicateGuardrail, distributeDesiredState]) expect(method).not.toHaveBeenCalled();
  });
  it.each([new ConflictError("Draft changed", "router_draft_conflict"), new ValidationError("Fallback weights must total 100%")])("returns actionable publication failures without distributing", async error => {
    const { send, trafficRouting, distributeDesiredState } = setupRoutingHttp(); trafficRouting.publish.mockRejectedValue(error);
    const response = await send("POST", "/routers/router/publish", { expectedDraftRevision: 1, idempotencyKey: "request" });
    expect(response.status).toBe(error.status); expect(await response.json()).toMatchObject({ error: { code: error.code, message: error.message } });
    expect(distributeDesiredState).not.toHaveBeenCalled();
  });
  it("forwards decision-window, revision and endpoint filters", async () => {
    const { send, trafficRouting } = setupRoutingHttp();
    expect((await send("GET", "/routers/router/distribution?hours=0.25&revision=2&endpointId=http")).status).toBe(200);
    expect(trafficRouting.distribution).toHaveBeenCalledExactlyOnceWith("router", 0.25, 2, "http");
  });
});
