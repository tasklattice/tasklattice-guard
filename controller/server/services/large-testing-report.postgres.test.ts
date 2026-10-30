// @vitest-environment node
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { loadSync, type MessageTypeDefinition } from "@grpc/proto-loader";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { testCases } from "../db/schema.js";
import { loadConfig } from "../config.js";
import { createHttpApp } from "../http/app.js";
import { ControlPlaneService } from "./control-plane.js";
import { RunnerControlServer } from "../control-channel/control-server.js";
import { profileDraft } from "../policy-catalog/presets.js";
import { fullFeatureBaseline } from "../../shared/full-feature-baseline.js";
import type { ControllerAuth } from "../auth.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ModelConfigurationService } from "../model-config/service.js";
import type { RunnerMessage__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/RunnerMessage.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("950-case full-feature report delivery", () => {
  it("executes real local checks and preserves all evidence through chunks", async () => {
    const database = await createTestDatabase(url!, "large_report");
    const directory = await mkdtemp(join(tmpdir(), "guard-large-report-"));
    await writeFile(join(directory, "private.pem"), generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
    const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
      CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: join(directory, "private.pem"),
      CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
      CONTROLLER_PROTO_PATH: resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"),
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
    const service = new ControlPlaneService(database.db, config);
    const metrics = { observeControlMessage: vi.fn(), controlConnection: vi.fn(), observeReconcile: vi.fn(), observeJob: vi.fn() } as unknown as ControllerMetrics;
    const control = new RunnerControlServer(config, service, metrics,
      { activeConfiguration: async () => null } as unknown as ModelConfigurationService);
    const stream = { write: vi.fn(), end: vi.fn() };
    const handle = (message: object, connection: unknown) => (control as unknown as {
      handleMessage(stream: unknown, message: object, connection: unknown): Promise<unknown>;
    }).handleMessage(stream, message, connection);
    let http: ReturnType<typeof serve> | undefined;
    try {
      await database.pool.query("INSERT INTO auth_user (id, name, email) VALUES ('report-user', 'Tester', 'report@example.test')");
      await service.initialize();
      const draft = profileDraft(fullFeatureBaseline, await service.listPolicies());
      // Reproduce the reported local-only composition: model Policies removed.
      draft.policyBindings = draft.policyBindings.filter(binding =>
        !["builtin-jailbreak-strict", "builtin-content-safety", "builtin-pii", "builtin-topic-safety"].includes(binding.policyId));
      const guardrail = await service.createGuardrail({ name: "Large local-only baseline", draftConfig: draft, runtimeProfile: "auto", actorId: "report-user" });
      const rows = await database.db.select().from(testCases).where(eq(testCases.guardrailId, guardrail.id));
      expect(rows.length).toBeGreaterThan(600);
      expect(rows.length).toBeLessThan(950);
      await database.db.insert(testCases).values(Array.from({ length: 950 - rows.length }, (_, index) => ({
        ...rows[index % rows.length]!, id: `repeat-${index}-${rows[index % rows.length]!.id}`,
      })));
      const connection = await handle({ registration: { runnerId: "report-runner-0", bootId: "report-boot", poolId: "default",
        compilerCapable: true, maxConcurrency: 64, runnerVersion: "test", nemoVersion: "test", labels: {} } }, null);
      const app = createHttpApp({ config, service, runnerControl: control, metrics,
        auth: { handler: async () => Response.json({}, { headers: { "set-cookie": "test-session=fixture; HttpOnly; Path=/" } }),
          api: { getSession: async ({ headers }: { headers: Headers }) => headers.get("cookie") === "test-session=fixture"
            ? { user: { id: "report-user", role: "user" } } : null } } as unknown as ControllerAuth });
      http = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
      await new Promise<void>(resolve => http!.listening ? resolve() : http!.once("listening", resolve));
      const address = http.address();
      if (!address || typeof address === "string") throw new Error("Missing listener");
      const base = `http://127.0.0.1:${address.port}`;
      const cli = async (command: string, flags: string[]) => {
        const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", resolve("src/cli/guardctl.ts"),
          "tenant", command, ...flags, `--url=${base}`], { timeout: 120_000, maxBuffer: 128 * 1024 * 1024,
          env: { ...process.env, GUARD_TENANT_TOKEN: "", GUARD_TENANT_USERNAME: "report-user", GUARD_TENANT_PASSWORD: "test-only" } });
        return JSON.parse(stdout.trim());
      };
      const run = await cli("test", ["--guardrail-id", guardrail.id, "--local-only"]);
      expect(run).toMatchObject({ status: "queued", metrics: { total: 950 } });
      const { rows: [event] } = await database.pool.query("SELECT payload FROM controller_outbox WHERE id=$1", [run.id]);
      const requestPath = join(directory, "request.json"), wirePath = join(directory, "report.pb");
      await writeFile(requestPath, JSON.stringify(event.payload));
      const { stdout } = await promisify(execFile)(resolve("../.venv/bin/python"),
        [resolve("../tests/fixtures/validation_report_worker.py"), requestPath, wirePath], { timeout: 100_000, maxBuffer: 1024 * 1024 });
      const delivery = JSON.parse(stdout.trim());
      expect(delivery).toMatchObject({ cases: 950, status: "VALIDATION_STATUS_PASSED" });
      expect(delivery.rawBytes).toBeGreaterThan(10 * 1024 * 1024);
      expect(delivery.wireBytes).toBeLessThan(delivery.rawBytes / 5);
      const definition = loadSync(config.protoPath, { includeDirs: [dirname(config.protoPath)], longs: String, enums: String, defaults: true, oneofs: true });
      const codec = definition["tasklattice.guard.control.v1.RunnerMessage"] as MessageTypeDefinition<object, RunnerMessage__Output>;
      await service.markValidationRunning(run.id);
      const wire = await readFile(wirePath);
      {
        expect(delivery.parts).toBeGreaterThan(10);
        for (let offset = 0; offset < wire.length;) {
          const length = wire.readUInt32BE(offset); offset += 4;
          const message = codec.deserialize(wire.subarray(offset, offset + length)); offset += length;
          await handle(message, connection);
          await handle(message, connection); // ACK loss must not duplicate cases.
        }
      }
      expect(stream.write).toHaveBeenLastCalledWith(expect.objectContaining({ validationReportAck: { runId: run.id } }));
      const summary = await cli("test-status", ["--run-id", run.id]);
      expect(summary).toMatchObject({ status: "passed", metrics: { total: 950, passed: 950 } });
      expect(summary).not.toHaveProperty("results");
      const page=await cli("test-cases",["--run-id",run.id]);
      expect(page.counts).toMatchObject({all:950,passed:950});
      expect(page.items).toHaveLength(50);
      expect(page.items.every((item:{passed:boolean})=>item.passed)).toBe(true);
      const detail=await cli("test-case",["--run-id",run.id,"--ordinal",String(page.items[0].ordinal)]);
      expect(detail.passed).toBe(true);
      expect(summary.testScope.modelInvocations).toBe(0);
    } finally {
      if (http) await new Promise<void>((resolve, reject) => http!.close(error => error ? reject(error) : resolve()));
      await control.stop();
      await service.stopReportWork();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
