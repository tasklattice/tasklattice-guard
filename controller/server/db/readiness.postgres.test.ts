// @vitest-environment node
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createDatabaseReadiness, ReadinessTimeoutError, StorageNotInitializedError } from "./readiness.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Database readiness deadlines (PostgreSQL)", () => {
  it("destroys a blocked probe socket, recovers, and preserves numeric generation", async () => {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url!).hostname)) throw new Error("Use a loopback test database.");
    const schema = `health_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: url, max: 1 });
    const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 2000, application_name: schema,
      options: `-c search_path=${schema}` });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await pool.query("CREATE TABLE controller_state (id text primary key, desired_generation bigint not null)");
      const probe = createDatabaseReadiness(pool, 150);
      await expect(probe()).rejects.toBeInstanceOf(StorageNotInitializedError);
      await pool.query("INSERT INTO controller_state VALUES ('singleton', 42)");
      await expect(probe(), "initialized storage").resolves.toBe(42);
      expect((await pool.query("SHOW statement_timeout")).rows[0]).toEqual({ statement_timeout: "0" });
      await admin.query("BEGIN");
      await admin.query(`LOCK TABLE "${schema}".controller_state IN ACCESS EXCLUSIVE MODE`);
      await expect(probe()).rejects.toBeInstanceOf(ReadinessTimeoutError);
      await vi.waitFor(() => expect(pool.totalCount).toBe(0));
      expect(pool.waitingCount).toBe(0);
      // The server must also stop work while the blocker still owns its lock.
      await vi.waitFor(async () => {
        await admin.query("SELECT pg_stat_clear_snapshot()");
        const active = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = $1", [schema]);
        expect(active.rows[0].count).toBe(0);
      });
      await admin.query("ROLLBACK");
      await expect(probe(), "recovery after locked query").resolves.toBe(42);
      expect(pool.idleCount).toBe(1);

      const holder = await pool.connect();
      try {
        const first = probe();
        await expect(first).rejects.toBeInstanceOf(ReadinessTimeoutError);
        for (let i = 0; i < 10; i++) expect(probe()).toBe(first);
        expect(pool.waitingCount).toBe(1);
      } finally { holder.release(); }
      await vi.waitFor(() => expect(pool.waitingCount).toBe(0));
      // Dequeueing precedes resolution of connect(); wait for the abandoned
      // checkout to be returned before expecting a fresh successful probe.
      await vi.waitFor(() => expect(pool.idleCount).toBe(1));
      await expect(probe(), "recovery after pool checkout").resolves.toBe(42);
    } finally {
      await admin.query("ROLLBACK");
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
});
