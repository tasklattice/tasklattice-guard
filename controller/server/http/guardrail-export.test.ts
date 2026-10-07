// @vitest-environment node
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import { ConflictError } from "../domain/errors.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

const version = "20261007-010000.000Z";
const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
function setup(role: string | null = "viewer") {
  const exportGuardrailVersion = vi.fn().mockResolvedValue({ artifactId: "artifact-1", guardrailId: "guard-1", guardrailVersion: version, checksum: "checksum", signature: "signature" });
  const app = createHttpApp({ config,
    auth: { api: { getSession: vi.fn().mockResolvedValue(role ? { user: { id: "reader", role } } : null) }, handler: vi.fn() } as unknown as ControllerAuth,
    service: { exportGuardrailVersion } as unknown as ControlPlaneService,
    runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics });
  return { app, exportGuardrailVersion };
}
describe("Guardrail export HTTP contract", () => {
  it("downloads the exact version as a non-cached attachment for a reader", async () => {
    const { app, exportGuardrailVersion } = setup();
    const response = await app.request(`/api/v1/guardrails/guard-1/versions/${version}/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="guard-1-${version}.artifact.json"`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ guardrailVersion: version, checksum: "checksum", signature: "signature" });
    expect(exportGuardrailVersion).toHaveBeenCalledWith("guard-1", version);
  });
  it("requires authentication", async () => {
    const { app, exportGuardrailVersion } = setup(null);
    expect((await app.request(`/api/v1/guardrails/guard-1/versions/${version}/export`)).status).toBe(401);
    expect(exportGuardrailVersion).not.toHaveBeenCalled();
  });
  it("rejects invalid version identifiers", async () => {
    const { app, exportGuardrailVersion } = setup();
    expect((await app.request("/api/v1/guardrails/guard-1/versions/latest/export")).status).toBe(400);
    expect(exportGuardrailVersion).not.toHaveBeenCalled();
  });
  it("returns a JSON error instead of an attachment when no Artifact is ready", async () => {
    const { app, exportGuardrailVersion } = setup();
    exportGuardrailVersion.mockRejectedValue(new ConflictError("Publish first", "guardrail_version_not_ready"));
    const response = await app.request(`/api/v1/guardrails/guard-1/versions/${version}/export`);
    expect(response.status).toBe(409);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: "guardrail_version_not_ready" } });
  });
});
