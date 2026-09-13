// @vitest-environment node
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Registry } from "prom-client";
import { createHttpApp } from "./app.js";
import { openApiDocument, apiModules } from "./openapi.js";
import { tokenRoutePermissions } from "./token-permissions.js";
import { loadConfig } from "../config.js";
import type { ControllerAuth } from "../auth.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";

// JSON contract assertions intentionally inspect arbitrary schema fields.
const contract = openApiDocument()! as any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addFormat("binary", true);
ajv.addSchema({ $id: "urn:guard:contract", components: contract.components });
function validate(schema: object, value: unknown) {
  const check = ajv.compile({ ...schema, components: contract.components });
  return { valid: check(value), errors: check.errors };
}
function setup() {
  const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://test:test@localhost/test",
    CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem",
    CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
  return createHttpApp({ config, auth: { api: { getSession: vi.fn().mockResolvedValue({ user: { id: "reader", role: "user" } }) } } as unknown as ControllerAuth,
    service: { trafficRouting: { list: async () => [] } } as unknown as ControlPlaneService,
    runnerControl: {} as RunnerControlServer, metrics: { registry: new Registry() } as ControllerMetrics });
}

describe("Generated OpenAPI contract", () => {
  it("is valid OpenAPI 3.1 and every generated schema compiles as JSON Schema 2020-12", async () => {
    await SwaggerParser.validate(structuredClone(contract));
    for (const name of Object.keys(contract.components.schemas)) {
      expect(() => ajv.compile({ $ref: `urn:guard:contract#/components/schemas/${name}` }), name).not.toThrow();
    }
  });
  it("documents every mounted product operation exactly once and excludes separate internal/auth contracts", () => {
    const actual = [...new Set(setup().routes.filter(route => route.path.startsWith("/api/v1/") && route.method !== "ALL")
      .map(route => `${route.method} ${route.path.replace(/:([^/]+)/g, "{$1}")}`))].sort();
    const documented = Object.entries(contract.paths).flatMap(([path, methods]) => Object.keys(methods as object).map(method => `${method.toUpperCase()} ${path}`)).sort();
    expect(documented).toEqual(actual);
    const ids = Object.values(contract.paths).flatMap(methods => Object.values(methods as object).map(operation => operation.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(contract.paths["/api/v1/routers/{id}"].patch).toBeUndefined();
    expect(Object.keys(contract.paths).every(path => path.startsWith("/api/v1/"))).toBe(true);
  });
  it("uses the enforced permission registry including read-only POST operations", () => {
    for (const [method, path, module, access] of tokenRoutePermissions) {
      const operation = contract.paths[path.replace(/:([^/]+)/g, "{$1}")][method.toLowerCase()];
      expect(operation["x-token-permission"]).toEqual({ module, access });
      expect(operation.security).toContainEqual({ personalAccessToken: [] });
      if (access === "write") expect(operation["x-token-account-role"]).toBe("admin");
    }
    expect(contract.paths["/api/v1/account/access-tokens"].post.security).toEqual([{ sessionCookie: [] }]);
    expect(contract.paths["/api/v1/system/status"].get.security).toEqual([]);
  });
  it("separates product tags from grants and describes retry boundaries for every operation", () => {
    for (const methods of Object.values(contract.paths) as any[]) {
      for (const operation of Object.values(methods) as any[]) {
        expect(operation.summary).toBeTruthy();
        expect(operation["x-product-area"]).toBeTruthy();
        expect(operation["x-idempotency"].mode).toBeTruthy();
        expect(operation["x-retry-policy"]).toBeTruthy();
      }
    }
    const traffic = contract.paths["/api/v1/routers/{id}/traffic-distribution"].get;
    expect(traffic.tags).toEqual(["telemetry"]);
    expect(traffic["x-token-permission"]).toEqual({ module: "routers", access: "read" });
    const publish = contract.paths["/api/v1/routers/{id}/publish"].post;
    expect(publish["x-idempotency"]).toMatchObject({ mode: "keyed", conflictStatus: 409 });
    expect(publish.description).toContain("publication.revision");
  });
  it("returns JSON 404 for removed API routes rather than the SPA", async () => {
    const app = setup();
    for (const path of ["/api/v1/whoami", "/api/v1/test-cases", "/api/v1/traffic-scope-fields"]) {
      const response = await app.request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
    }
  });
  it("preserves required fields, optional defaults, enum constraints and runtime validation notes", () => {
    const tokens = contract.paths["/api/v1/account/access-tokens"].post.requestBody.content["application/json"].schema;
    expect(validate(tokens, { name: "Automation", permissions: { routers: "read" }, expiresInDays: 30 }).valid).toBe(true);
    expect(validate(tokens, { name: "Automation", permissions: { routers: "read" }, expiresInDays: 31 }).valid).toBe(false);
    expect(validate(tokens, { name: "Automation", permissions: { audit: "write" }, expiresInDays: 30 }).valid).toBe(false);
    const publish = contract.paths["/api/v1/routers/{id}/publish"].post;
    expect(validate(publish.requestBody.content["application/json"].schema, { expectedDraftRevision: 1, idempotencyKey: "review-1" }).valid).toBe(true);
    expect(validate(publish.requestBody.content["application/json"].schema, { expectedDraftRevision: 1 }).valid).toBe(false);
    expect(validate(publish.requestBody.content["application/json"].schema, { expectedDraftRevision: 0, idempotencyKey: "review-1" }).valid).toBe(false);
    expect(publish.responses[202].description).toContain("does not guarantee");
    const intent = contract.paths["/api/v1/authoring/intent-analyses"].post.requestBody.content["application/json"].schema;
    expect(validate(intent, { purpose: "Block unsafe user requests and protect personal information." }).valid).toBe(true);
    const version = contract.components.schemas.deleteGuardrailsByIdVersionsByVersionParamVersion;
    expect(version.description).toContain("YYYYMMDD-HHmmss.SSSZ");
    expect(version["x-runtime-validation"]).toBeDefined();
  });
  it.each(apiModules)("retains complete, resolvable schema references for module %s", async module => {
    const filtered = openApiDocument({ module })!;
    expect(Object.values(filtered.paths).flatMap(Object.values).every(operation => operation.tags.includes(module))).toBe(true);
    await SwaggerParser.validate(structuredClone(filtered) as any);
    expect(Object.keys(filtered.components.schemas).length).toBeLessThan(Object.keys(contract.components.schemas).length);
  });
  it("serves docs and a single-operation contract without a session, rejects unknown filters", async () => {
    const app = setup();
    const response = await app.request("/api/openapi.json?operationId=postRoutersByIdPublish");
    expect(response.status).toBe(200);
    const document = await response.json() as any;
    expect(Object.keys(document.paths)).toEqual(["/api/v1/routers/{id}/publish"]);
    await SwaggerParser.validate(document);
    expect((await app.request("/api/openapi.json?module=missing")).status).toBe(404);
    expect((await app.request("/api/openapi.json?module=routers&operationId=getGuardrails")).status).toBe(404);
    const html = await app.request("/api/docs");
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("Download full OpenAPI JSON");
    expect(await (await app.request("/api/llms.txt")).text()).toContain("postRoutersByIdPublish: POST");
  });
  it("validates serialized handler responses including identity, nulls and errors", async () => {
    const app = setup();
    for (const path of ["/api/v1/account/identity", "/api/v1/routers"]) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      const result = validate(contract.paths[path].get.responses[200].content["application/json"].schema, await response.json());
      expect(result.errors).toBeNull();
    }
    expect(validate({ $ref: "#/components/schemas/Error" }, { error: { code: "invalid_request", message: "Invalid input", detail: {} } }).valid).toBe(true);
    expect(validate({ $ref: "#/components/schemas/Error" }, { error: "failed" }).valid).toBe(false);
  });
});
