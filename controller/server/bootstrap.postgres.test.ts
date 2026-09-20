// @vitest-environment node
import { readFile } from "node:fs/promises";
import { hashPassword } from "better-auth/crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "./auth.js";
import { ensureBootstrapAdmin } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import * as schema from "./db/schema.js";

// All writes are to session-local temporary tables, including Better Auth writes.
describe.skipIf(!process.env.GUARD_BOOTSTRAP_TEST_DATABASE_URL)("bootstrap hash login (PostgreSQL)", () => {
  const pool = new Pool({ connectionString: process.env.GUARD_BOOTSTRAP_TEST_DATABASE_URL, max: 1 });
  const db = drizzle(pool, { schema });
  const config = loadConfig({
    NODE_ENV: "test", CONTROLLER_DATABASE_URL: process.env.GUARD_BOOTSTRAP_TEST_DATABASE_URL ?? "postgresql://unused:unused@localhost/unused",
    CONTROLLER_RUNNER_TOKEN: "test-runner-token-at-least-32-characters",
    CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/unused-test-signing-key",
    BETTER_AUTH_SECRET: "test-auth-secret-at-least-32-characters",
    CONTROLLER_PUBLIC_URL: "http://localhost:38081",
  });
  const auth = createAuth(config, db);
  beforeAll(async () => {
    const migration = await readFile(new URL("./db/migrations/0000_baseline.sql", import.meta.url), "utf8");
    for (const name of ["auth_user", "auth_account", "auth_session", "auth_verification"]) {
      const statement = migration.match(new RegExp(`CREATE TABLE "${name}" \\([\\s\\S]*?\\n\\);`))?.[0];
      if (!statement) throw new Error(`Missing auth table fixture: ${name}`);
      await pool.query(statement.replace("CREATE TABLE", "CREATE TEMP TABLE"));
    }
  });
  afterAll(async () => { await pool.end(); });

  it("logs in with password, rejects the hash as a password, and never resets an existing account", async () => {
    const hash = await hashPassword("password");
    const input = { auth, db, email: "admin@example.test", name: "Administrator", passwordHash: hash };
    expect(await ensureBootstrapAdmin(input)).toBe("created");
    const signedIn = await auth.api.signInEmail({ body: { email: input.email, password: "password" } });
    expect(signedIn.user.email).toBe(input.email);
    const [stored] = await db.select().from(schema.account).where(eq(schema.account.userId, signedIn.user.id));
    expect(stored?.password).toBe(hash);
    await expect(auth.api.signInEmail({ body: { email: input.email, password: hash } })).rejects.toThrow();
    await expect(auth.api.signInEmail({ body: { email: input.email, password: "incorrect" } })).rejects.toThrow();
    expect(await ensureBootstrapAdmin({ ...input, passwordHash: await hashPassword("replacement") })).toBe("existing");
    expect((await auth.api.signInEmail({ body: { email: input.email, password: "password" } })).user.id).toBe(signedIn.user.id);
  });
});
