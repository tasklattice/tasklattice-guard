// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import type { ControllerAuth } from "../auth.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

const token = "legacy-runner-token-with-at-least-32-characters";
const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://unused:unused@localhost/unused",
  CONTROLLER_RUNNER_TOKEN: token, CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem", BETTER_AUTH_SECRET: "better-auth-secret-with-at-least-32-characters" });
const path = "http://controller/api/internal/v1/runtime-events";
const make = (recordRuntimeEvents = vi.fn().mockResolvedValue(undefined)) => ({ recordRuntimeEvents,
  app: createHttpApp({ config, service: { recordRuntimeEvents, recordTelemetryWatermark: vi.fn().mockResolvedValue(undefined) } as unknown as ControlPlaneService,
    auth: { api: {} } as ControllerAuth, runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics }) });
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const body = JSON.stringify({ events: [], runnerId: "runner-a" });

describe("telemetry upload budgets are wired before parsing/persistence", () => {
  it("authenticates before reading a body", async () => {
    let reads = 0;
    const stream = new ReadableStream({ pull() { reads++; throw new Error("unauthorized body must not be read"); } }, { highWaterMark: 0 });
    const request = new Request(path, { method: "POST", body: stream, duplex: "half" } as RequestInit);
    const { app, recordRuntimeEvents } = make();
    expect((await app.request(request)).status).toBe(401);
    expect(reads).toBe(0); expect(recordRuntimeEvents).not.toHaveBeenCalled();
  });

  it.each(["lying-length", "invalid-utf8", "excess-depth"])("rejects %s before event writes", async kind => {
    const bytes = kind === "lying-length" ? new Uint8Array(8 * 1024 * 1024 + 1) :
      kind === "invalid-utf8" ? new Uint8Array([0xff]) : new TextEncoder().encode("[".repeat(65) + "]".repeat(65));
    const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    const { app, recordRuntimeEvents } = make();
    const request = new Request(path, { method: "POST", headers: { ...headers, "content-length": "1" }, body: stream, duplex: "half" } as RequestInit);
    const response = await app.request(request);
    expect(response.status).toBe(kind === "invalid-utf8" ? 400 : 413);
    expect(recordRuntimeEvents).not.toHaveBeenCalled();
  });

  it("bounds concurrent accepted uploads and releases on parse errors and completion", async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    const persist = vi.fn(async () => { if (++calls === 2) entered(); await gate; });
    const { app } = make(persist);
    const send = (value = body) => app.request(path, { method: "POST", headers, body: value });
    const first = send(), second = send();
    await started;
    const denied = await send();
    expect(denied.status).toBe(503); expect(denied.headers.get("retry-after")).toBe("1");
    release();
    expect((await first).status).toBe(202); expect((await second).status).toBe(202);
    expect((await send("{")).status).toBe(400);
    expect((await send()).status).toBe(202);
  });

  it("rejects excessive per-event and batch metered-call work before transactions", async () => {
    const { app, recordRuntimeEvents } = make();
    const event = (calls: number) => ({ id: "event", requestId: "call", runnerId: "runner", occurredAt: new Date().toISOString(),
      direction: "incoming", decision: "allow", durationMs: 1, metadata: { usage: { model_calls: Array.from({ length: calls }, () => ({})) } } });
    for (const events of [[event(65)], Array.from({ length: 5 }, () => event(64))]) {
      expect((await app.request(path, { method: "POST", headers, body: JSON.stringify({ events }) })).status).toBe(413);
    }
    expect(recordRuntimeEvents).not.toHaveBeenCalled();
  });
});
