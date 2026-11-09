// @vitest-environment node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Registry } from "prom-client";
import { expect, it, vi } from "vitest";
import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import type { ControllerMetrics } from "../metrics.js";
import { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
const token = "endpoint-pipeline-test-token-at-least-32-characters";

it.skipIf(!url).each(["trace", "models"])("delivers a real Endpoint %s backlog to project counters and Runtime logs", async scenario => {
  const database = await createTestDatabase(url!, "endpoint_pipeline");
  const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!, CONTROLLER_RUNNER_TOKEN: token,
    CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/unused.pem", BETTER_AUTH_SECRET: "test-auth-secret-at-least-32-characters" });
  const service = new ControlPlaneService(database.db, config);
  const getSession = vi.fn().mockResolvedValue({ session: { id: "test-session", activeProjectId: "projectA" },
    user: { id: "test-user", role: "user" } });
  const app = createHttpApp({ config, service, auth: { api: { getSession } } as unknown as ControllerAuth,
    runnerControl: {} as RunnerControlServer, metrics: { registry: new Registry() } as ControllerMetrics });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test HTTP port");
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    child = spawn(`${root}.venv/bin/python`, ["-m", "tests.fixtures.endpoint_telemetry_pipeline",
      `http://127.0.0.1:${address.port}/api/internal/v1/runtime-events`, token, scenario], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += chunk; });
    const exited = new Promise<number | null>((resolve, reject) => { child!.once("error", reject); child!.once("exit", resolve); });
    const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    const read = async () => {
      const line = await lines.next();
      if (line.done) throw new Error(`Runner fixture exited: ${stderr}`);
      return JSON.parse(line.value);
    };
    const generated = await read();
    expect(generated.statuses).toEqual(Array(6).fill(200));
    if (scenario === "trace") expect(generated.batchBytes).toBeGreaterThan(8 * 1024 * 1024);
    else expect(generated.modelCalls).toBe(300);
    await database.pool.query("INSERT INTO guardrail(id,project_id,name,draft_config) VALUES ($1,'projectA','Fixture','{}')", [generated.guardrailId]);
    await database.pool.query("INSERT INTO endpoint(id,project_id,name,adapter) VALUES ('fixture-endpoint','projectA','Fixture','litellm-generic-guardrail')");
    await database.pool.query("INSERT INTO traffic_router(id,project_id,name,draft) VALUES ($1,'projectA','Fixture','{}')", [generated.routerId]);
    child.stdin!.end("ready\n");
    const delivered = await read();
    expect(await exited, stderr).toBe(0);
    expect(delivered.uploads.length).toBeGreaterThan(1);
    expect(delivered.uploads.every((status: number) => status === 202)).toBe(true);
    expect(delivered.remainingEvents).toBe(0);
    // Use the same project-scoped HTTP reads as the Portal, including auth and filters.
    const readPortal = async (path: string) => {
      const response = await app.request(path, { headers: { "x-project-id": "projectA" } });
      expect(response.status).toBe(200);
      return response.json();
    };
    const activity = (await readPortal("/api/v1/telemetry/endpoint-activity")).items[0];
    expect(activity).toMatchObject({ id: "fixture-endpoint", request_count: 6, error_count: 0 });
    expect(Number(activity.detection_p95_ms)).toBeGreaterThan(0);
    const logs = await readPortal("/api/v1/telemetry/events?endpointId=fixture-endpoint");
    expect(logs.items.map((event: { id: string }) => event.id).sort()).toEqual(generated.runtimeEventIds.sort());
    const rows = await database.pool.query("SELECT id, project_id, metadata->>'contentCiphertext' AS body FROM runtime_event");
    expect(rows.rows).toHaveLength(6);
    expect(rows.rows.every(row => row.project_id === "projectA")).toBe(true);
    if (scenario === "trace") {
      for (const row of rows.rows) expect(createHash("sha256").update(row.body).digest("hex")).toBe(generated.ciphertextDigests[row.id]);
    }
    else {
      expect(rows.rows.every(row => row.body === null)).toBe(true);
      expect(Number((await database.pool.query("SELECT count(*) FROM model_usage_cost")).rows[0].count)).toBe(300);
    }
  } finally {
    child?.kill();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await database.drop();
  }
}, 60_000);
