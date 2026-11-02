// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "./auth.js";
import { ensureBootstrapAdmin, ensureBootstrapUser } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { createTestDatabase } from "./db/postgres-test-database.js";
import * as schema from "./db/schema.js";

describe.skipIf(!process.env.GUARD_BOOTSTRAP_TEST_DATABASE_URL)("username bootstrap (PostgreSQL)", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let auth: ReturnType<typeof createAuth>;
  beforeAll(async () => {
    const url = process.env.GUARD_BOOTSTRAP_TEST_DATABASE_URL!;
    database = await createTestDatabase(url, "username_bootstrap");
    const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url,
      CONTROLLER_RUNNER_TOKEN: "test-runner-token-at-least-32-characters",
      CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/unused-test-signing-key",
      BETTER_AUTH_SECRET: "test-auth-secret-at-least-32-characters", CONTROLLER_PUBLIC_URL: "http://localhost:38081" });
    auth = createAuth(config, database.db);
  });
  afterAll(async () => { await database?.drop(); });

  it.each([["admin", ensureBootstrapAdmin], ["user", ensureBootstrapUser]] as const)("overwrites %s credentials, preserves ID, and invalidates existing sessions", async (role, ensure) => {
    const input = { auth, username: role, name: role, password: "first-password" };
    await ensure(input);
    const first = await auth.api.signInUsername({ body: { username: role, password: input.password }, asResponse: true });
    expect(first.status).toBe(200);
    const cookies = first.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const headers = new Headers({ cookie: cookies });
    const original = (await auth.api.getSession({ headers, query: { disableCookieCache: true } }))!;
    expect(await ensure({ ...input, password: "password" })).toBe("updated");
    expect(await auth.api.getSession({ headers, query: { disableCookieCache: true } })).toBeNull();
    await expect(auth.api.signInUsername({ body: { username: role, password: input.password } })).rejects.toThrow();
    const signedIn = await auth.api.signInUsername({ body: { username: role, password: "password" } });
    expect(signedIn.user).toMatchObject({ id: original.user.id, username: role, role });
    const [stored] = await database.db.select().from(schema.account).where(eq(schema.account.userId, signedIn.user.id));
    expect(stored?.password).not.toBe("password");
    await expect(auth.api.signInUsername({ body: { username: role, password: stored!.password! } })).rejects.toThrow();
  });
});
