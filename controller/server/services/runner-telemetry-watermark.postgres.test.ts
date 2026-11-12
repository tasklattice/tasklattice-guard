// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runnerAuthEnv } from "../../test/runner-auth-fixture.js";
import { loadConfig } from "../config.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { ControlPlaneService } from "./control-plane.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Runner heartbeat telemetry watermark", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "runner_telemetry_watermark");
    service = new ControlPlaneService(database.db, loadConfig({
      NODE_ENV: "test", CONTROLLER_DATABASE_URL: url,
      BETTER_AUTH_SECRET: "synthetic-auth-secret-at-least-32-characters",
      CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/unused-test-key.pem", ...runnerAuthEnv(),
    }));
    await database.pool.query(`INSERT INTO controller_state(id,desired_generation) VALUES ('singleton',0) ON CONFLICT DO NOTHING;
      INSERT INTO runner_pool(id,name,is_default) VALUES ('default','Default',true) ON CONFLICT DO NOTHING`);
  }, 30000);
  afterAll(async () => { await database?.drop(); });

  it("uses the drain time from the current control session without extending replay freshness", async () => {
    const runner = { runnerId: "runner-default-0", bootId: "boot-a", poolId: "default",
      runnerVersion: "test", nemoVersion: "test", maxConcurrency: 4, compilerCapable: true, labels: {}, appliedGeneration: 0 };
    const generation = await service.registerRunner(runner, "session-a");
    const load = { inflight: 0, maxConcurrency: 4, queueDepth: 0, requestsDelta: 0, errorsDelta: 0, timeoutsDelta: 0,
      latencyP95Ms: 0, cpuUtilization: 0, memoryUtilization: 0, activeGuardrails: 0, compileQueueDepth: 0, observationIntervalMs: 1000 };
    const heartbeat = (sequence: number, drainedAt: number) => service.recordHeartbeat({
      runnerId: runner.runnerId, bootId: runner.bootId, controlSessionId: "session-a", sequence,
      appliedGeneration: generation, load, telemetryDrainedAtUnixMs: drainedAt,
    });
    const watermark = async () => (await service.observabilitySnapshot()).watermarks;

    expect(await heartbeat(1, Date.now() + 60_000)).toBe(true);
    expect(await watermark()).toEqual([]);

    const drainedAt = Date.now();
    expect(await heartbeat(2, drainedAt)).toBe(true);
    expect(await watermark()).toEqual([{ runnerId: runner.runnerId, lastReceivedAt: new Date(drainedAt) }]);
    expect(await heartbeat(2, Date.now())).toBe(false);
    expect(await heartbeat(3, drainedAt - 1)).toBe(true);
    expect(await watermark()).toEqual([{ runnerId: runner.runnerId, lastReceivedAt: new Date(drainedAt) }]);

    await service.registerRunner({ ...runner, bootId: "boot-b" }, "session-b");
    expect(await heartbeat(4, Date.now())).toBe(false);
    expect(await watermark()).toEqual([]);
  });
});
