// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseErrorFields, databasePoolState, logDatabaseFailure, reportSaveStage, withReportSaveDiagnostics } from "./diagnostics.js";

afterEach(() => vi.restoreAllMocks());
const secret = "REPORT_AND_CREDENTIAL_SENTINEL";
const pool = { options: { max: 20, connectionString: secret }, totalCount: 20, idleCount: 0, waitingCount: 7 };
const db = { $client: pool };

describe("database diagnostic privacy and attribution", () => {
  it.each([
    ["55P03", "lock_unavailable"], ["57014", "query_cancelled"], ["40P01", "deadlock"],
    ["53300", "too_many_connections"], ["25P03", "idle_transaction_timeout"], ["08006", "connection_error"],
    ["57P01", "connection_error"], ["23505", "database_error"], ["ECONNRESET", "network_error"], ["EPIPE", "network_error"],
  ])("extracts %s through wrapped causes without exporting database values", (code, category) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = Object.assign(new Error(secret), { code, detail: secret, hint: secret, client: { password: secret } });
    const error = Object.assign(new Error(secret, { cause }), { query: secret, params: [secret], stack: secret });
    logDatabaseFailure("database.test", error, databasePoolState(db), { runId: "run-1" });
    const output = logged.mock.calls[0]![0];
    expect(output).not.toContain(secret);
    expect(JSON.parse(output)).toMatchObject({ error: { category, code, sqlState: code.length === 5 && code !== "EPIPE" ? code : null },
      pool: { max: 20, total: 20, idle: 0, busy: 20, waiting: 7 }, runId: "run-1" });
  });

  it.each([
    ["timeout exceeded when trying to connect", "pool_acquire_timeout"],
    ["Connection terminated due to connection timeout", "connection_timeout"],
  ])("classifies uncoded driver failure %s", (message, category) => {
    expect(databaseErrorFields(new Error(secret, { cause: new Error(message) })))
      .toEqual({ category, code: null, sqlState: null });
  });

  it("bounds cyclic causes, ignores arbitrary codes, and marks missing pool counters as unavailable", () => {
    const error = { code: secret, message: secret, cause: undefined as unknown };
    error.cause = error;
    expect(databaseErrorFields(error)).toEqual({ category: "unknown", code: null, sqlState: null });
    expect(databasePoolState({})).toBeNull();
  });

  it("logs a stage before it blocks, correlates concurrent saves and separates retry attempts", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const blocked = Promise.withResolvers<void>();
    const first = withReportSaveDiagnostics(db, "run-1", () => reportSaveStage("lock_guardrail", () => blocked.promise));
    expect(info.mock.calls.map(([line]) => JSON.parse(line))).toContainEqual(expect.objectContaining({ runId: "run-1", stage: "lock_guardrail", status: "started" }));
    await withReportSaveDiagnostics(db, "run-2", () => withReportSaveDiagnostics(db, "run-2", () => reportSaveStage("write_report", () => secret)));
    blocked.reject(Object.assign(new Error(secret), { code: "55P03", detail: secret }));
    await expect(first).rejects.toThrow(secret);
    await withReportSaveDiagnostics(db, "run-1", () => reportSaveStage("write_report", () => secret));
    const lines = [...info.mock.calls, ...errors.mock.calls].map(([line]) => JSON.parse(line));
    expect(JSON.stringify(lines)).not.toContain(secret);
    const attempts = lines.filter(line => line.stage === "save" && line.status === "started");
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map(line => line.attemptId)).size).toBe(3);
    for (const attempt of attempts) {
      const events = lines.filter(line => line.attemptId === attempt.attemptId);
      expect(events.every(line => line.runId === attempt.runId)).toBe(true);
      expect(events.every(line => line.durationMs >= 0 && line.elapsedMs >= 0)).toBe(true);
      expect(events.some(line => line.stage === "save" && line.status !== "started")).toBe(true);
    }
    expect(lines).toContainEqual(expect.objectContaining({ stage: "lock_guardrail", status: "failed",
      error: { category: "lock_unavailable", code: "55P03", sqlState: "55P03" } }));
  });
});
