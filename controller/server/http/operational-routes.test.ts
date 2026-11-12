// @vitest-environment node
import { runnerAuthEnv } from "../../test/runner-auth-fixture.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { ReadinessTimeoutError, StorageNotInitializedError } from "../db/readiness.js";
import { createHttpApp } from "./app.js";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }));
});
const software = { version: "v1.2.3", commit: "abc123", branch: "main", dirty: false, source: "build" };
function setup(withUi = true) {
  const ui = mkdtempSync(join(tmpdir(), "guard-operational-routes-"));
  directories.push(ui);
  if (withUi) writeFileSync(join(ui, "index.html"), "<!doctype html><title>Guard</title>");
  vi.stubEnv("TALI_BUILD_INFO", JSON.stringify(software));
  const readiness = vi.fn(async () => 42);
  const getSession = vi.fn(async () => { throw new Error("Database-backed authentication is unavailable."); });
  const listRunnerPoolsWithCapacity = vi.fn(async () => { throw new Error("Database unavailable."); });
  let stopping = false;
  const app = createHttpApp({
    config: loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://test:test@localhost/test",
      ...runnerAuthEnv("runner-token-that-is-at-least-32-characters"), CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test.pem",
      CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
      CONTROLLER_UI_DIST: withUi ? ui : join(ui, "missing"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" }),
    auth: { api: { getSession } }, service: { readiness, listRunnerPoolsWithCapacity },
    runnerControl: {}, metrics: {}, isStopping: () => stopping,
  } as unknown as Parameters<typeof createHttpApp>[0]);
  return { app, readiness, getSession, listRunnerPoolsWithCapacity, stop: () => { stopping = true; } };
}

it("serves healthz and readiness with the same uncached, public JSON contract", async () => {
  const { app, readiness, getSession } = setup();
  for (const path of ["/healthz", "/health/ready"]) {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ component: "guard-controller", status: "ready", ready: true,
      reason: "ready", error: null, desiredGeneration: 42 });
  }
  expect(readiness).toHaveBeenCalledTimes(2);
  expect(getSession).not.toHaveBeenCalled();
});

it.each([
  [new Error("postgres://secret:password@private/db"), "storage_unavailable"],
  [new ReadinessTimeoutError(), "storage_timeout"],
  [new StorageNotInitializedError(), "storage_uninitialized"],
])("reports dependency failures as 503 without leaking details (%s)", async (error, reason) => {
  const { app, readiness } = setup();
  readiness.mockRejectedValue(error);
  for (const path of ["/healthz", "/health/ready"]) {
    const response = await app.request(path);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ component: "guard-controller", status: "not_ready", ready: false,
      reason, error: { code: reason, message: "Controller storage is not ready." } });
  }
  readiness.mockResolvedValue(43);
  expect((await app.request("/healthz")).status).toBe(200);
});

it("reads only the startup version snapshot and keeps liveness/version available during outages and shutdown", async () => {
  const { app, readiness, getSession, listRunnerPoolsWithCapacity, stop } = setup();
  readiness.mockRejectedValue(new Error("Storage unavailable"));
  // Neither a changed environment nor a request should reread Git/build identity.
  vi.stubEnv("TALI_BUILD_INFO", "invalid");
  for (const stopping of [false, true]) {
    if (stopping) stop();
    const response = await app.request("/version");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ component: "guard-controller", ...software });
    const live = await app.request("/health/live");
    expect(live.status).toBe(200);
    expect(live.headers.get("cache-control")).toBe("no-store");
    expect(await live.json()).toEqual({ status: "ok", component: "guard-controller" });
  }
  expect(readiness).not.toHaveBeenCalled();
  expect(getSession).not.toHaveBeenCalled();
  expect(listRunnerPoolsWithCapacity).not.toHaveBeenCalled();
});

it("uses the readiness envelope during shutdown without accessing storage", async () => {
  const { app, stop, readiness } = setup();
  stop();
  for (const path of ["/healthz", "/health/ready"]) {
    const response = await app.request(path);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ component: "guard-controller", status: "not_ready", ready: false,
      reason: "stopping", error: { code: "stopping", message: "Controller is stopping." } });
  }
  expect(readiness).not.toHaveBeenCalled();
});

it("does not report ready when shutdown starts during a storage check", async () => {
  const { app, stop, readiness } = setup();
  readiness.mockImplementation(async () => { stop(); return 42; });
  const response = await app.request("/healthz");
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ ready: false, reason: "stopping" });
});

it.each([true, false])("never serves SPA HTML for unknown operational paths or methods (UI=%s)", async withUi => {
  const { app } = setup(withUi);
  for (const path of ["/health", "/health/typo", "/healthz/typo", "/version/typo"]) {
    const response = await app.request(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "Route not found." } });
  }
  for (const path of ["/healthz", "/health/ready", "/health/live", "/version"]) {
    expect((await app.request(path, { method: "POST" })).status).toBe(404);
    const response = await app.request(path, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  }
  if (withUi) {
    const response = await app.request("/project/settings");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<!doctype html>");
  }
});
