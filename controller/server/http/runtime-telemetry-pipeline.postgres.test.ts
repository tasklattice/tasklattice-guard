// @vitest-environment node
import { spawn } from "node:child_process";
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
const token = "runtime-pipeline-test-token-at-least-32-characters";
const GUARDRAIL_ID = "fixture-guardrail";
const ENDPOINT_ID = "fixture-endpoint";

type Upload = { status: number; accepted: number | null };
type WalEvent = { id: string; costOnly: boolean; calls: number; modelInvocations: number | null };
type LogicalEvent = { id: string; requestId: string; calls: number; costOnly: boolean };

// A real Runtime exporter (disk WAL transport) drives a real Controller app
// backed by PostgreSQL. The assertions below are the same project-scoped HTTP
// reads the Portal/Dashboard performs, plus the durable rows behind them.
it.skipIf(!url)("delivers split Runtime telemetry to Controller rows and Dashboard read APIs", async () => {
  const database = await createTestDatabase(url!, "runtime_pipeline");
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
    child = spawn(`${root}.venv/bin/python`, ["-m", "tests.fixtures.runtime_telemetry_pipeline",
      `http://127.0.0.1:${address.port}/api/internal/v1/runtime-events`, token], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += chunk; });
    const exited = new Promise<number | null>((resolve, reject) => { child!.once("error", reject); child!.once("exit", resolve); });
    const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    const read = async () => {
      const line = await lines.next();
      if (line.done) throw new Error(`Runner fixture exited: ${stderr}`);
      return JSON.parse(line.value);
    };
    const generated = await read() as { guardrailId: string; endpointId: string; logicalEvents: LogicalEvent[] };
    const [normal1, normal2, normal3, large, validation] = generated.logicalEvents;
    expect(generated.logicalEvents!.map(event => event.calls)).toEqual([2, 2, 2, 65, 300]);
    // The Node side owns the claimed Controller identities; they exist before upload.
    await database.pool.query("INSERT INTO guardrail(id,project_id,name,draft_config) VALUES ($1,'projectA','Fixture','{}')", [generated.guardrailId]);
    await database.pool.query("INSERT INTO endpoint(id,project_id,name,adapter) VALUES ($1,'projectA','Fixture','litellm-generic-guardrail')", [generated.endpointId]);
    child.stdin!.end("ready\n");
    const delivered = await read() as {
      drainError?: string; walEvents: WalEvent[]; uploads: Upload[]; replayUploads: Upload[];
      remainingEvents: number; remainingAfterReplay: number;
    };
    expect(await exited, stderr).toBe(0);
    expect(delivered.drainError, stderr).toBeUndefined();

    // Emit-level split: an event above 64 model calls keeps one main record
    // (the first 64 calls) plus deterministic cost-only companions for the
    // remainder. The 65-call Runtime event becomes 64 + 1; the 300-call
    // validation cost event becomes five chunks of at most 64 calls
    // (64/64/64/64/44).
    const companions = (base: string, chunks: number[]) =>
      chunks.map((calls, index) => ({ id: `${base}#cost-${index + 1}`, costOnly: true, calls, modelInvocations: calls }));
    expect(delivered.walEvents).toEqual([
      { id: normal1!.id, costOnly: false, calls: 2, modelInvocations: 2 },
      { id: normal2!.id, costOnly: false, calls: 2, modelInvocations: 2 },
      { id: normal3!.id, costOnly: false, calls: 2, modelInvocations: 2 },
      { id: large!.id, costOnly: false, calls: 64, modelInvocations: 65 },
      { id: `${large!.id}#cost-1`, costOnly: true, calls: 1, modelInvocations: 1 },
      { id: validation!.id, costOnly: true, calls: 64, modelInvocations: 300 },
      ...companions(validation!.id, [64, 64, 64, 44]),
    ] as WalEvent[]);

    // Strict Controller receipts: every upload is accepted in full, and the WAL
    // is empty after both the initial drain and the replay.
    expect(delivered.uploads.length).toBeGreaterThanOrEqual(2);
    expect(delivered.uploads.every(item => item.status === 202)).toBe(true);
    expect(delivered.uploads.reduce((total, item) => total + (item.accepted ?? -1), 0)).toBe(delivered.walEvents.length);
    expect(delivered.remainingEvents).toBe(0);
    // Replaying the same acknowledged records (lost-response window) is idempotent.
    expect(delivered.replayUploads.length).toBeGreaterThanOrEqual(2);
    expect(delivered.replayUploads.every(item => item.status === 202)).toBe(true);
    expect(delivered.replayUploads.reduce((total, item) => total + (item.accepted ?? -1), 0)).toBe(delivered.walEvents.length);
    expect(delivered.remainingAfterReplay).toBe(0);

    // Runtime logs keep exactly one event per request: split companions are
    // cost-only evidence and never appear as Runtime events.
    const runtimeRows = (await database.pool.query("SELECT id, project_id, metadata FROM runtime_event ORDER BY id")).rows;
    expect(runtimeRows.map(row => row.id).sort()).toEqual([normal1!.id, normal2!.id, normal3!.id, large!.id].sort());
    expect(runtimeRows.every(row => row.id.includes("#cost-") === false)).toBe(true);
    expect(runtimeRows.every(row => row.project_id === "projectA")).toBe(true);
    expect(runtimeRows.every(row => row.metadata.costOnly !== true)).toBe(true);
    const largeRow = runtimeRows.find(row => row.id === large!.id)!;
    expect(largeRow.metadata.usage.model_calls).toHaveLength(64);
    // The main chunk preserves the logical request's full model_invocations so
    // Dashboard request statistics keep the true provider-call total.
    expect(largeRow.metadata.usage.model_invocations).toBe(65);

    // Every model call is priced exactly once across the main event and its
    // companions: 3*2 + 65 + 300 = 371 rows with deterministic, idempotent ids.
    // Legacy validation cost-only events carry no Endpoint, so those 300 testing
    // rows are intentionally not project-attributed; the 71 Runtime calls are.
    const costSummary = (await database.pool.query(`SELECT count(*)::int AS rows,
        count(DISTINCT id)::int AS ids, sum(calls)::int AS calls,
        count(DISTINCT event_id)::int AS events,
        count(*) FILTER (WHERE event_id LIKE '%#cost-%')::int AS companion_rows,
        count(*) FILTER (WHERE project_id = 'projectA')::int AS attributed,
        count(*) FILTER (WHERE id !~ '^[a-f0-9]{64}$')::int AS malformed
        FROM model_usage_cost`)).rows[0];
    expect(costSummary).toEqual({ rows: 371, ids: 371, calls: 371, events: 10, companion_rows: 237, attributed: 71, malformed: 0 });

    // --- Dashboard read APIs (the same project-scoped HTTP reads the Portal uses).
    const readPortal = async (path: string) => {
      const response = await app.request(path, { headers: { "x-project-id": "projectA" } });
      expect(response.status).toBe(200);
      return response.json();
    };
    // Runtime log list: all four requests visible exactly once, no cost companions.
    const logs = await readPortal(`/api/v1/telemetry/events?endpointId=${ENDPOINT_ID}`);
    expect(logs.items.map((event: { id: string }) => event.id).sort())
      .toEqual([normal1!.id, normal2!.id, normal3!.id, large!.id].sort());
    // Request statistics: 4 decisions, 3 allow + 1 block, and 71 model invocations
    // (2 + 2 + 2 + 65) even though the largest event was split into two receipts.
    const metrics = await readPortal("/api/v1/telemetry/metrics?window=24h");
    expect(metrics).toMatchObject({ total_decisions: 4, allowed: 3, blocked: 1, model_invocations: 71 });
    // Endpoint activity: four distinct request ids counted for the Endpoint.
    const activity = (await readPortal("/api/v1/telemetry/endpoint-activity")).items[0];
    expect(activity).toMatchObject({ id: ENDPOINT_ID, request_count: 4, error_count: 0 });
    expect(Number(activity.detection_p95_ms)).toBeGreaterThan(0);
    // Cost view: the split companion's single call is included (64 + 1 for the
    // large request), so the dashboard cost table totals 71 Runtime calls.
    const costs = await readPortal(`/api/v1/guardrails/${GUARDRAIL_ID}/usage-costs?window=7d&source=all`);
    expect(costs).toMatchObject({ calls: 71 });

    // Replay must not have duplicated any durable evidence.
    expect(Number((await database.pool.query("SELECT count(*) FROM runtime_event")).rows[0].count)).toBe(4);
    expect(Number((await database.pool.query("SELECT count(*) FROM model_usage_cost")).rows[0].count)).toBe(371);
  } finally {
    child?.kill();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await database.drop();
  }
}, 120_000);
