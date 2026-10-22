// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { ControlPlaneService } from "./control-plane.js";
import { loadConfig } from "../config.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Endpoint Scan defaults in PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "scan_defaults");
    await database.pool.query("INSERT INTO auth_user(id,name,email,role) VALUES ('admin','Admin','scan@test.local','admin')");
    await database.pool.query("INSERT INTO controller_state(id,desired_generation) VALUES ('singleton',0)");
    const config = loadConfig({
      NODE_ENV: "test", CONTROLLER_DATABASE_URL: url,
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
      CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/unused-signing-key.pem",
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
      CONTROLLER_RUNTIME_PUBLIC_URL: "http://runtime.test",
    });
    service = new ControlPlaneService(database.db, config);
  });
  afterAll(async () => { await database?.drop(); });

  it("preserves the initial true default and persists false with audit and distribution", async () => {
    const created = await service.createEndpoint({ name: "Scan", adapter: "f5-scan", actorId: "admin" });
    expect(created.scanFlagOnlyDefault).toBe(true);
    const credentialId = created.credentials[0]!.id;
    expect((await service.updateEndpoint({ id: created.id, scanFlagOnlyDefault: false, actorId: "admin" })).scanFlagOnlyDefault).toBe(false);
    const loaded = await service.getEndpoint(created.id);
    expect(loaded.scanFlagOnlyDefault).toBe(false);
    expect(loaded.credentials[0]!.id).toBe(credentialId);
    expect((await database.pool.query("SELECT desired_generation::int AS desired_generation FROM controller_state")).rows[0].desired_generation).toBe(2);
    expect((await database.pool.query("SELECT detail FROM audit_event WHERE resource_id=$1 AND kind='endpoint.updated'", [created.id])).rows[0].detail)
      .toMatchObject({ previousScanFlagOnlyDefault: true, scanFlagOnlyDefault: false, generation: 2 });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM controller_outbox WHERE aggregate_id=$1", [created.id])).rows[0].n).toBe(2);
    // Reapplying the same default is a no-op; changing status keeps the default.
    await service.updateEndpoint({ id: created.id, scanFlagOnlyDefault: false, actorId: "admin" });
    expect((await database.pool.query("SELECT desired_generation::int AS desired_generation FROM controller_state")).rows[0].desired_generation).toBe(2);
    expect(await service.updateEndpoint({ id: created.id, enabled: false, actorId: "admin" }))
      .toMatchObject({ status: "disabled", scanFlagOnlyDefault: false });
  });

  it("accepts false at creation and rejects Scan settings for LiteLLM", async () => {
    expect(await service.createEndpoint({ name: "Explicit", adapter: "f5-scan", scanFlagOnlyDefault: false, actorId: "admin" }))
      .toMatchObject({ scanFlagOnlyDefault: false });
    await expect(service.createEndpoint({ name: "Invalid", adapter: "litellm-generic-guardrail", scanFlagOnlyDefault: false, actorId: "admin" }))
      .rejects.toThrow("only supported by F5");
    const lite = await service.createEndpoint({ name: "Lite", adapter: "litellm-generic-guardrail", actorId: "admin" });
    await expect(service.updateEndpoint({ id: lite.id, scanFlagOnlyDefault: false, actorId: "admin" })).rejects.toThrow("only supported by F5");
    expect((await service.getEndpoint(lite.id)).status).toBe("active");
  });
});
