// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createPooledDatabase } from "./client.js";
import { runMigrations, SCHEMA_BASELINE } from "./migrate.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Current database schema baseline", () => {
  let admin: Pool; let pool: Pool; let name: string;
  let config: ReturnType<typeof loadConfig>;
  const migrate = () => runMigrations(config, createPooledDatabase(pool));
  beforeEach(async () => {
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(new URL(url!).hostname);
    name = `migration_${randomUUID().replaceAll("-", "")}`;
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE "${name}"`);
    const target = new URL(url!); target.pathname = `/${name}`;
    pool = new Pool({ connectionString: target.toString(), max: 2 });
    config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: target.toString(),
      CONTROLLER_RUNNER_TOKEN: "test-runner-token-32-characters-long",
      BETTER_AUTH_SECRET: "test-auth-secret-32-characters-long",
      CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/unused-test-key.pem",
      CONTROLLER_MIGRATIONS_PATH: resolve("server/db/migrations") });
  });
  afterEach(async () => {
    // Own these references while asynchronous database teardown completes. A
    // delayed teardown must never close the next test's replacement pool.
    const ownedPool = pool, ownedAdmin = admin, databaseName = name;
    try {
      await ownedPool?.end();
      if (databaseName) await ownedAdmin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } finally { await ownedAdmin?.end(); }
  }, 30_000);
  it("serializes concurrent fresh installs and seeds only once", async () => {
    await Promise.all([migrate(), migrate()]);
    expect((await pool.query("SELECT count(*)::int AS n FROM guardrail_profile")).rows[0].n).toBe(5);
    expect((await pool.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT to_regclass('validation_report_state') AS report")).rows[0].report).toBe("validation_report_state");
    await expect(pool.query("INSERT INTO guardrail_profile(id,category,category_name,is_default,enabled,definition) SELECT 'duplicate',category,category_name,true,true,definition FROM guardrail_profile WHERE id='banking-assistant'"))
      .rejects.toMatchObject({ code: "23505" });
    expect(pool.waitingCount).toBe(0);
  });
  it("preserves current installed data, edited Profiles and migration history on restart", async () => {
    await migrate();
    await pool.query("UPDATE guardrail_profile SET enabled=false,definition=jsonb_set(definition,'{name}','\"User-owned\"') WHERE id='banking-assistant'");
    await pool.query("UPDATE drizzle.__drizzle_migrations SET hash='current-v1-baseline'");
    const before = (await pool.query("SELECT * FROM guardrail_profile ORDER BY id")).rows;
    await migrate();
    expect((await pool.query("SELECT * FROM guardrail_profile ORDER BY id")).rows).toEqual(before);
    expect((await pool.query("SELECT hash FROM drizzle.__drizzle_migrations")).rows).toEqual([{ hash: "current-v1-baseline" }]);
  });
  it("refuses an incomplete historical upgrade without applying schema changes", async () => {
    await pool.query("CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY, hash text NOT NULL,created_at bigint)");
    await pool.query("INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES ('old',$1)", [SCHEMA_BASELINE - 1]);
    await expect(migrate()).rejects.toThrow("Initialize a fresh V1 database");
    expect((await pool.query("SELECT to_regclass('guardrail_profile') AS profile")).rows[0].profile).toBeNull();
    expect((await pool.query("SELECT hash FROM drizzle.__drizzle_migrations")).rows).toEqual([{ hash: "old" }]);
  });
  it("rolls back an unsuccessful baseline and can retry cleanly", async () => {
    const directory = mkdtempSync(join(tmpdir(), "guard-migration-"));
    const originalPath = config.migrationsPath;
    try {
      mkdirSync(join(directory, "meta"));
      writeFileSync(join(directory, "meta/_journal.json"), readFileSync(join(originalPath, "meta/_journal.json")));
      writeFileSync(join(directory, "0000_current_schema.sql"), readFileSync(join(originalPath, "0000_current_schema.sql"), "utf8") + "\nSELECT missing_relation FROM missing_relation;");
      await expect(runMigrations({ ...config, migrationsPath: directory }, createPooledDatabase(pool))).rejects.toThrow();
      expect((await pool.query("SELECT to_regclass('guardrail_profile') AS profile")).rows[0].profile).toBeNull();
      expect((await pool.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations")).rows[0].n).toBe(0);
      await migrate();
      expect((await pool.query("SELECT count(*)::int AS n FROM guardrail_profile")).rows[0].n).toBe(5);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
