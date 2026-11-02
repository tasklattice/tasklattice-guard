// @vitest-environment node
import { sql } from "drizzle-orm";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { createDatabase, withDatabaseConnection } from "./client.js";
import { reportSaveStage, withReportSaveDiagnostics } from "./diagnostics.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
function database(overrides: Record<string, string> = {}) {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url!).hostname)) throw new Error("Loopback database required");
  const connection = createDatabase(loadConfig({
    NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
    CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
    CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
    BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
    ...overrides,
  }));
  connection.pool.options.max = 1;
  connection.pool.options.connectionTimeoutMillis = 200;
  return connection;
}

describe.skipIf(!url)("Controller transaction connection ownership (PostgreSQL)", () => {
  let lines: Array<Record<string, any>>;
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "info").mockImplementation(line => { lines.push(JSON.parse(line)); });
    vi.spyOn(console, "error").mockImplementation(line => { lines.push(JSON.parse(line)); });
  });
  afterEach(() => vi.restoreAllMocks());

  it("cancels SQL on the server and releases lock waits with the configured budgets", async () => {
    const { db, pool } = database({ CONTROLLER_DATABASE_STATEMENT_TIMEOUT_MS: "150", CONTROLLER_DATABASE_LOCK_TIMEOUT_MS: "50" });
    const blockerPool = database().pool;
    const blocker = await blockerPool.connect();
    const key = Math.floor(Math.random() * 2_000_000_000);
    try {
      const settings = (await pool.query("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock")).rows[0];
      expect(settings).toEqual({ statement: "150ms", lock: "50ms" });
      await expect(db.execute(sql`SELECT pg_sleep(2)`)).rejects.toMatchObject({ cause: { code: "57014" } });
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock($1)", [key]);
      await expect(db.transaction(tx => tx.execute(sql`SELECT pg_advisory_xact_lock(${key})`)))
        .rejects.toMatchObject({ cause: { code: "55P03" } });
      expect(pool.idleCount).toBe(1);
      expect((await pool.query("SELECT 1 AS alive")).rows).toEqual([{ alive: 1 }]);
      expect(pool.waitingCount).toBe(0);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await blockerPool.end(); await pool.end(); }
  });

  it("discards a checkout with an extended maintenance budget instead of leaking session settings", async () => {
    const { pool } = database({ CONTROLLER_DATABASE_STATEMENT_TIMEOUT_MS: "30" });
    try {
      await withDatabaseConnection(pool, async scoped => {
        await scoped.execute(sql`SET statement_timeout = '1000ms'`);
        await scoped.execute(sql`SELECT pg_sleep(0.1)`);
      }, true);
      expect(pool.totalCount).toBe(0);
      expect((await pool.query("SHOW statement_timeout")).rows[0]).toEqual({ statement_timeout: "30ms" });
    } finally { await pool.end(); }
  });

  it.each([["backend termination", "57P01"], ["idle transaction timeout", "25P03"]])("survives %s between transaction statements and replaces the broken connection", async (mode, sqlState) => {
    // A separate process is essential: an unhandled Client error would kill
    // the server, and an error listener in this test would conceal that bug.
    const script = `
      import { Pool } from 'pg';
      import { sql } from 'drizzle-orm';
      import { createDatabase } from './server/db/client.ts';
      import { loadConfig } from './server/config.ts';
      import { databaseErrorFields, withReportSaveDiagnostics } from './server/db/diagnostics.ts';
      const url = process.env.GUARD_TEST_POSTGRES_URL;
      const { db, pool } = createDatabase(loadConfig({ NODE_ENV: 'test', CONTROLLER_DATABASE_URL: url,
        CONTROLLER_RUNNER_TOKEN: 'runner-token-that-is-at-least-32-characters',
        CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: '/tmp/controller-signing-key.pem',
        BETTER_AUTH_SECRET: 'better-auth-secret-that-is-at-least-32-characters' }));
      pool.options.max = 1;
      const admin = new Pool({ connectionString: url, max: 1 });
      let client, failed = false;
      pool.on('acquire', value => { client = value; });
      try {
        try { await withReportSaveDiagnostics(db, 'terminated-run', () => db.transaction(async tx => {
          const pid = (await tx.execute(sql\`SELECT pg_backend_pid() AS pid\`)).rows[0].pid;
          const ended = new Promise(resolve => client.once('end', resolve));
          if (${JSON.stringify(mode)} === 'backend termination') await admin.query('SELECT pg_terminate_backend($1)', [pid]);
          else await tx.execute(sql\`SET LOCAL idle_in_transaction_session_timeout = '50ms'\`);
          await ended;
          await tx.execute(sql\`SELECT 1\`);
        })); } catch (error) { failed = true; console.log(JSON.stringify({ event: 'rejected', ...databaseErrorFields(error) })); }
        if (!failed) throw new Error('Transaction unexpectedly succeeded');
        console.log(JSON.stringify({ event: 'recovered', rows: (await pool.query('SELECT 1 AS alive')).rows,
          total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }));
      } finally { await pool.end(); await admin.end(); }
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, GUARD_TEST_POSTGRES_URL: url! }, timeout: 6_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", errors = "";
    child.stdout.on("data", value => { output += value; });
    child.stderr.on("data", value => { errors += value; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    expect(code, errors).toBe(0);
    const logs = (output + errors).split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
    const attemptId = logs.find(line => line.stage === "save" && line.status === "started").attemptId;
    expect(logs).toContainEqual(expect.objectContaining({ event: "database.transaction_connection_error", runId: "terminated-run", attemptId,
      error: expect.objectContaining({ sqlState }) }));
    expect(logs).toContainEqual(expect.objectContaining({ event: "rejected", sqlState }));
    expect(logs).toContainEqual({ event: "recovered", rows: [{ alive: 1 }], total: 1, idle: 1, waiting: 0 });
  }, 10_000);

  it("distinguishes pool acquisition failure from BEGIN failure", async () => {
    const { db, pool } = database();
    const occupied = await pool.connect();
    const body = vi.fn();
    try {
      await expect(withReportSaveDiagnostics(db, "pool-timeout", () => db.transaction(body))).rejects.toThrow("timeout exceeded when trying to connect");
      expect(body).not.toHaveBeenCalled();
      expect(lines).toContainEqual(expect.objectContaining({ stage: "pool_acquire", status: "failed",
        pool: { max: 1, total: 1, busy: 1, idle: 0, waiting: 0 },
        error: { category: "pool_acquire_timeout", code: null, sqlState: null },
      }));
      expect(lines.some(line => line.stage === "begin")).toBe(false);
    } finally { occupied.release(); await pool.end(); }
  });

  it("returns the only connection when BEGIN fails, so subsequent queries do not time out", async () => {
    const { db, pool } = database();
    const client = await pool.connect();
    const query = vi.spyOn(client, "query").mockRejectedValueOnce(new Error("injected BEGIN failure"));
    client.release();
    let released = false;
    pool.once("release", () => { released = true; });
    const body = vi.fn();
    try {
      await expect(withReportSaveDiagnostics(db, "begin-failure", () => db.transaction(body))).rejects.toMatchObject({ cause: { message: "injected BEGIN failure" } });
      expect(lines).toContainEqual(expect.objectContaining({ stage: "begin", status: "failed" }));
      expect(lines).toContainEqual(expect.objectContaining({ stage: "pool_release", status: "succeeded", pool: expect.objectContaining({ idle: 1 }) }));
      expect(body).not.toHaveBeenCalled();
      expect(released).toBe(true);
      expect((await pool.query("SELECT 1 AS alive")).rows).toEqual([{ alive: 1 }]);
      expect(pool.waitingCount).toBe(0);
    } finally {
      query.mockRestore();
      // Also let the regression fail cleanly on the old, leaking adapter.
      if (!released) client.release(true);
      await pool.end();
    }
  });

  it("discards a connection if rollback fails instead of reusing an open transaction", async () => {
    const { db, pool } = database();
    const client = await pool.connect();
    const originalQuery = client.query.bind(client);
    const query = vi.spyOn(client, "query").mockImplementation(((...args: Parameters<typeof client.query>) => {
      const command = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
      return command === "rollback" ? Promise.reject(new Error("injected ROLLBACK failure")) : originalQuery(...args);
    }) as typeof client.query);
    const oldPid = (await originalQuery("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    client.release();
    try {
      await expect(withReportSaveDiagnostics(db, "rollback-failure", () => db.transaction(async tx => {
        await tx.execute(sql`SELECT 1`);
        throw new Error("report write failed");
      }))).rejects.toMatchObject({ cause: { message: "injected ROLLBACK failure" } });
      expect(lines).toContainEqual(expect.objectContaining({ stage: "rollback", status: "failed" }));
      expect(lines).toContainEqual(expect.objectContaining({ stage: "pool_release", status: "succeeded", pool: expect.objectContaining({ total: 0 }) }));
      expect(pool.totalCount).toBe(0);
      const { rows } = await pool.query("SELECT pg_backend_pid() AS pid");
      expect(rows[0].pid).not.toBe(oldPid);
    } finally { query.mockRestore(); await pool.end(); }
  });

  it("records a COMMIT failure after a successful write without logging constraint detail", async () => {
    const { db, pool } = database();
    const secret = "PRIVATE_REPORT_COMMIT_SENTINEL";
    try {
      await pool.query("CREATE TEMP TABLE report_commit_diagnostics (id text UNIQUE DEFERRABLE INITIALLY DEFERRED)");
      await expect(withReportSaveDiagnostics(db, "commit-failure", () => db.transaction(async tx => {
        await reportSaveStage("write_report", () => tx.execute(sql`INSERT INTO report_commit_diagnostics VALUES (${secret}), (${secret})`));
      }))).rejects.toMatchObject({ cause: { code: "23505" } });
      expect(lines).toContainEqual(expect.objectContaining({ stage: "write_report", status: "succeeded" }));
      expect(lines).toContainEqual(expect.objectContaining({ stage: "commit", status: "failed", error: { category: "database_error", code: "23505", sqlState: "23505" } }));
      expect(lines).toContainEqual(expect.objectContaining({ stage: "rollback", status: "succeeded" }));
      expect(lines.some(line => line.stage === "save" && line.status === "succeeded")).toBe(false);
      expect(JSON.stringify(lines)).not.toContain(secret);
      expect(pool.idleCount).toBe(1);
      expect((await pool.query("SELECT * FROM report_commit_diagnostics")).rows).toHaveLength(0);
    } finally { await pool.end(); }
  });

  it("reuses one connection for commits, successful rollbacks and nested savepoints", async () => {
    const { db, pool } = database();
    const pid = (await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    try {
      await expect(withReportSaveDiagnostics(db, "nested-savepoint", () => db.transaction(async tx => {
        await tx.transaction(async nested => {
          expect((await nested.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0]?.pid).toBe(pid);
        });
        throw new Error("business conflict");
      }))).rejects.toThrow("business conflict");
      expect(lines).toContainEqual(expect.objectContaining({ stage: "savepoint", status: "succeeded" }));
      expect(lines).toContainEqual(expect.objectContaining({ stage: "release_savepoint", status: "succeeded" }));
      await db.transaction(async tx => {
        expect((await tx.execute(sql`SHOW transaction_read_only`)).rows[0]).toEqual({ transaction_read_only: "on" });
        expect((await tx.execute(sql`SHOW transaction_isolation`)).rows[0]).toEqual({ transaction_isolation: "repeatable read" });
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
      expect((await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid).toBe(pid);
      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(1);
      expect(pool.waitingCount).toBe(0);
    } finally { await pool.end(); }
  });

  it("does not accumulate error listeners across repeated transaction checkouts", async () => {
    const { db, pool } = database();
    const client = await pool.connect();
    client.release();
    try {
      const baseline = client.listenerCount("error");
      for (let i = 0; i < 25; i++) {
        await db.transaction(async tx => { await tx.execute(sql`SELECT 1`); });
        expect(client.listenerCount("error")).toBe(baseline);
        expect(pool.idleCount).toBe(1);
      }
    } finally { await pool.end(); }
  });

  it("owns a migration checkout even though the migrator bypasses db.transaction", async () => {
    const { pool } = database();
    const namespace = `migration_pool_${randomUUID().replaceAll("-", "")}`;
    const client = await pool.connect();
    const original = client.query.bind(client);
    const query = vi.spyOn(client, "query").mockImplementation(((...args: Parameters<typeof client.query>) => {
      const command = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
      return /^begin\b/.test(command) ? Promise.reject(new Error("migration BEGIN failed")) : original(...args);
    }) as typeof client.query);
    client.release();
    try {
      await expect(withDatabaseConnection(pool, scoped => migrate(scoped, {
        migrationsFolder: "server/db/migrations", migrationsSchema: namespace,
      }))).rejects.toMatchObject({ cause: { message: "migration BEGIN failed" } });
      expect(pool.idleCount).toBe(1);
      expect((await pool.query("SELECT 1 AS alive")).rows).toEqual([{ alive: 1 }]);
      expect(client.listenerCount("error")).toBe(1);
    } finally {
      query.mockRestore();
      // The schema is generated by this test; never remove shared migration metadata.
      if (pool.idleCount === 0) client.release(true);
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    }
  });
});
