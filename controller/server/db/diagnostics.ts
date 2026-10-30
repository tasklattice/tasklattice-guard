import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

type PoolState = { max: number; total: number; idle: number; busy: number; waiting: number };
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Only numeric counters cross this boundary; never serialize a Pool/Client. */
export function databasePoolState(databaseOrPool: unknown): PoolState | null {
  const value = record(databaseOrPool);
  const pool = record(value?.$client) ?? value;
  const max = record(pool?.options)?.max;
  const total = pool?.totalCount, idle = pool?.idleCount, waiting = pool?.waitingCount;
  return count(max) && count(total) && count(idle) && count(waiting)
    ? { max, total, idle, busy: Math.max(0, total - idle), waiting } : null;
}

const networkCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

/** Drizzle errors contain SQL/params; PostgreSQL detail/message may contain
 * row values; pg can attach a Client with credentials. Export codes only.
 */
export function databaseErrorFields(error: unknown) {
  const seen = new Set<object>();
  let value = record(error), code: string | null = null, sqlState: string | null = null;
  let timeout: string | null = null;
  while (value && !seen.has(value) && seen.size < 16) {
    seen.add(value);
    if (typeof value.code === "string") {
      if (/^[0-9A-Z]{5}$/.test(value.code) && !networkCodes.has(value.code)) sqlState = value.code;
      else if (networkCodes.has(value.code)) code = value.code;
    }
    // Exact driver messages classify uncoded failures without exporting text.
    if (value.message === "timeout exceeded when trying to connect") timeout = "pool_acquire_timeout";
    if (value.message === "Connection terminated due to connection timeout") timeout = "connection_timeout";
    value = record(value.cause);
  }
  const category = timeout ?? (sqlState === "55P03" ? "lock_unavailable"
    : sqlState === "57014" ? "query_cancelled"
    : sqlState === "40P01" ? "deadlock"
    : sqlState === "53300" ? "too_many_connections"
    : sqlState === "25P03" ? "idle_transaction_timeout"
    : sqlState?.startsWith("08") || ["57P01", "57P02", "57P03"].includes(sqlState ?? "") ? "connection_error"
    : sqlState ? "database_error" : code ? "network_error" : "unknown");
  return { category, code: sqlState ?? code, sqlState };
}

const identifier = (value: string) => /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : "[redacted]";
type ErrorContext = { operation?: string; runId?: string; attemptId?: string; runnerId?: string; bootId?: string; route?: string; method?: string };

export function logDatabaseFailure(event: string, error: unknown, pool: PoolState | null, context: ErrorContext = {}): void {
  const { operation, runId, attemptId, runnerId, bootId, route, method } = context;
  console.error(JSON.stringify({ event, timestamp: new Date().toISOString(), pool, error: databaseErrorFields(error),
    ...(operation ? { operation } : {}), ...(runId ? { runId: identifier(runId) } : {}),
    ...(attemptId ? { attemptId: identifier(attemptId) } : {}),
    ...(runnerId ? { runnerId: identifier(runnerId) } : {}), ...(bootId ? { bootId: identifier(bootId) } : {}),
    ...(route ? { route } : {}), ...(method ? { method } : {}),
  }));
}

type Stage = "save" | "lookup_policy_run" | "lookup_run" | "pool_acquire" | "pool_release"
  | "begin" | "commit" | "rollback" | "savepoint" | "release_savepoint" | "rollback_savepoint"
  | "set_timeouts" | "lock_guardrail" | "lock_run" | "lock_parent_run" | "verify_candidate"
  | "load_candidate_request" | "normalize_candidate" | "digest_candidate" | "validate_scope"
  | "write_report" | "complete_outbox" | "write_audit" | "prune_history" | "aggregate_policy_results";

const reports = new AsyncLocalStorage<ReportSaveDiagnostics>();
const milliseconds = (start: number) => Math.round((performance.now() - start) * 10) / 10;

class ReportSaveDiagnostics {
  readonly attemptId = randomUUID();
  private readonly started = performance.now();
  constructor(readonly runId: string, private readonly db: unknown) {}

  async stage<T>(stage: Stage, task: () => T | PromiseLike<T>): Promise<T> {
    const started = performance.now();
    this.log(stage, "started", started);
    try {
      const result = await task();
      this.log(stage, "succeeded", started);
      return result;
    } catch (error) {
      this.log(stage, "failed", started, error);
      throw error;
    }
  }

  private log(stage: Stage, status: "started" | "succeeded" | "failed", started: number, error?: unknown) {
    const entry = JSON.stringify({ event: "validation.report_save", timestamp: new Date().toISOString(),
      runId: identifier(this.runId), attemptId: this.attemptId, stage, status,
      durationMs: milliseconds(started), elapsedMs: milliseconds(this.started), pool: databasePoolState(this.db),
      ...(status === "failed" ? { error: databaseErrorFields(error) } : {}),
    });
    if (status === "failed") console.error(entry); else console.info(entry);
  }
}

export function withReportSaveDiagnostics<T>(db: unknown, runId: string, task: () => Promise<T>): Promise<T> {
  // Policy jobs can enter through ControlPlaneService or directly.
  if (reports.getStore()?.runId === runId) return task();
  const trace = new ReportSaveDiagnostics(runId, db);
  return reports.run(trace, () => trace.stage("save", task));
}

export function reportSaveStage<T>(stage: Stage, task: () => T | PromiseLike<T>): Promise<T> {
  const trace = reports.getStore();
  return trace ? trace.stage(stage, task) : Promise.resolve().then(task);
}

/** Capture at checkout: socket error events may run in an older async context. */
export function reportSaveContext(): Pick<ErrorContext, "runId" | "attemptId"> {
  const trace = reports.getStore();
  return trace ? { runId: trace.runId, attemptId: trace.attemptId } : {};
}

/** Observe Drizzle's transaction commands on a per-checkout facade. The pooled
 * Client is never patched, so concurrent saves cannot inherit another trace.
 * Query text is inspected only to identify commands, and is never logged.
 */
export function reportTransactionClient(client: PoolClient): PoolClient {
  const trace = reports.getStore();
  if (!trace) return client;
  return new Proxy(client, { get(target, key, receiver) {
    if (key !== "query") return Reflect.get(target, key, receiver);
    return (...args: unknown[]) => {
      const query = typeof args[0] === "string" ? args[0] : record(args[0])?.text;
      const text = typeof query === "string" ? query.trim().toLowerCase() : "";
      const stage = /^begin(?:\s|$)/.test(text) ? "begin" : text === "commit" ? "commit" : text === "rollback" ? "rollback"
        : text.startsWith("rollback to savepoint ") ? "rollback_savepoint" : text.startsWith("release savepoint ") ? "release_savepoint"
        : text.startsWith("savepoint ") ? "savepoint" : null;
      const execute = () => Reflect.apply(target.query, target, args);
      return stage ? trace.stage(stage, execute) : execute();
    };
  } });
}
