// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";
import { routeCapabilities, routeCapability } from "./route-capabilities.js";

const source = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
const routes = [...source.matchAll(/app\.(get|post|put|patch|delete)\(["'](\/api\/v1\/[^"']+)["']/g)]
  .map(([, method, path]) => [method!.toUpperCase(), path!] as const);

/** A receiving environment: authoring off and no Policy Library on disk. */
function production() {
  const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
    CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
    CONTROLLER_POLICY_CATALOG_DIR: "/nonexistent-policy-library", CONTROLLER_AUTHORING_ENABLED: "false", CONTROLLER_PACKAGE_TRUST_PATH: "/etc/guard/trust.json",
    BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
  const service = new Proxy({}, { get: () => vi.fn(async () => { throw new Error("A disabled route reached the service."); }) });
  return createHttpApp({ config,
    auth: { api: { getSession: vi.fn().mockResolvedValue({ user: { id: "admin", role: "admin" } }) }, handler: vi.fn() } as unknown as ControllerAuth,
    service: service as unknown as ControlPlaneService, runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics });
}

describe("deployment route capabilities", () => {
  it("classifies every API route exactly once", () => {
    for (const [method, path] of routes) {
      expect(routeCapabilities.filter(([verb, template]) => verb === method && template === path), `${method} ${path}`).toHaveLength(1);
    }
    expect(routeCapabilities.filter(([verb, template]) => !routes.some(([method, path]) => method === verb && path === template))).toEqual([]);
  });

  it("treats unknown operations as authoring", () => {
    expect(routeCapability("POST", "/api/v1/future-operation")).toBe("authoring");
    expect(routeCapability("PATCH", "/api/v1/routers/id")).toBe("authoring");
    expect(routeCapability("GET", "/api/v1/guardrails/id")).toBe("core");
  });

  it("starts without a Policy Library and reports itself as a receiving environment", async () => {
    const response = await production().request("/api/v1/deployment/capabilities");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authoringEnabled: false, packageExport: { available: false, sourceId: null }, packageImport: { available: true } });
  });

  it.each(routeCapabilities.filter(([, , capability]) => capability === "authoring"))("refuses %s %s before reaching the service", async (method, template) => {
    const path = template.replace(/:[^/]+/g, "x");
    const response = await production().request(path, { method, headers: { "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("authoring_disabled");
  });
});
