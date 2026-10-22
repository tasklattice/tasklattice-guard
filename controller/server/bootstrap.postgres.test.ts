// @vitest-environment node
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "./auth.js";
import { ensureBootstrapAdmin, ensureBootstrapUser } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import type { ControllerDatabase } from "./db/client.js";
import { createTestDatabase } from "./db/postgres-test-database.js";
import * as schema from "./db/schema.js";

// Better Auth writes use an isolated schema with the current migrations.
describe.skipIf(!process.env.GUARD_BOOTSTRAP_TEST_DATABASE_URL)("bootstrap hash login (PostgreSQL)", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let db: ControllerDatabase;
  let auth: ReturnType<typeof createAuth>;
  const config = loadConfig({
    NODE_ENV: "test", CONTROLLER_DATABASE_URL: process.env.GUARD_BOOTSTRAP_TEST_DATABASE_URL ?? "postgresql://unused:unused@localhost/unused",
    CONTROLLER_RUNNER_TOKEN: "test-runner-token-at-least-32-characters",
    CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/unused-test-signing-key",
    BETTER_AUTH_SECRET: "test-auth-secret-at-least-32-characters",
    CONTROLLER_PUBLIC_URL: "http://localhost:38081",
  });
  beforeAll(async () => {
    database = await createTestDatabase(process.env.GUARD_BOOTSTRAP_TEST_DATABASE_URL!, "bootstrap_login");
    db = database.db;
    auth = createAuth(config, db);
  }, 30_000);
  afterAll(async () => { await database?.drop(); });

  it.each([["admin", ensureBootstrapAdmin], ["user", ensureBootstrapUser]] as const)("logs in %s with password and never resets its credentials", async (role, ensure) => {
    const hash = await hashPassword("password");
    const input = { auth, db, email: `${role}@example.test`, name: role, passwordHash: hash };
    expect(await ensure(input)).toBe("created");
    const signedIn = await auth.api.signInEmail({ body: { email: input.email, password: "password" } });
    expect(signedIn.user.email).toBe(input.email);
    expect(signedIn.user.role).toBe(role);
    const [stored] = await db.select().from(schema.account).where(eq(schema.account.userId, signedIn.user.id));
    expect(stored?.password).toBe(hash);
    await expect(auth.api.signInEmail({ body: { email: input.email, password: hash } })).rejects.toThrow();
    await expect(auth.api.signInEmail({ body: { email: input.email, password: "incorrect" } })).rejects.toThrow();
    expect(await ensure({ ...input, passwordHash: await hashPassword("replacement") })).toBe("existing");
    expect((await auth.api.signInEmail({ body: { email: input.email, password: "password" } })).user.id).toBe(signedIn.user.id);
  });
});
