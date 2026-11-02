// @vitest-environment node
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";
import { createAuth, type ControllerAuth } from "./auth.js";
import type { ControllerDatabase } from "./db/client.js";
import { loadConfig } from "./config.js";
import { BootstrapAccountSynchronizer, ensureBootstrapAdmin, ensureBootstrapUser } from "./bootstrap.js";

function fixture() {
  const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://unused:unused@localhost/unused",
    CONTROLLER_RUNNER_TOKEN: "test-runner-token-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/unused-key",
    BETTER_AUTH_SECRET: "test-auth-secret-at-least-32-characters", CONTROLLER_PUBLIC_URL: "http://localhost:8080" });
  const data: Record<string, Array<Record<string, any>>> = { user: [], account: [], session: [], verification: [] };
  const options = createAuth(config, {} as ControllerDatabase).options;
  const auth = betterAuth({ ...options, database: memoryAdapter(data),
    databaseHooks: { ...options.databaseHooks, session: undefined } });
  return { auth: auth as unknown as ControllerAuth, data };
}

describe("username authentication and authoritative bootstrap", () => {
  it.each([["admin", ensureBootstrapAdmin], ["user", ensureBootstrapUser]] as const)("signs in the %s role through Better Auth", async (role, ensure) => {
    const { auth, data } = fixture();
    expect(await ensure({ auth, username: role, password: "password", name: role })).toBe("created");
    const login = await auth.api.signInUsername({ body: { username: role.toUpperCase(), password: "password" } });
    expect(login.user).toMatchObject({ username: role, role });
    expect(data.account[0]!.password).not.toBe("password");
    expect(data.account[0]!.password).not.toBe(Buffer.from("password").toString("base64"));
    await expect(auth.api.signInUsername({ body: { username: role, password: "Password" } })).rejects.toThrow();
    await expect(auth.api.signInUsername({ body: { username: `${role}@tasklattice.local`, password: "password" } })).rejects.toThrow();
  });
  it.each([["admin", ensureBootstrapAdmin], ["user", ensureBootstrapUser]] as const)("overwrites existing %s credentials and role, retains ID and revokes sessions", async (role, ensure) => {
    const { auth, data } = fixture();
    const input = { auth, username: role, password: "previous-password", name: "Previous name" };
    await ensure(input);
    const login = await auth.api.signInUsername({ body: { username: role, password: input.password } });
    expect(data.session).toHaveLength(1);
    data.user[0]!.role = role === "admin" ? "user" : "admin";
    data.user[0]!.banned = true;
    expect(await ensure({ ...input, password: "password", name: "Reset name" })).toBe("updated");
    expect(data.user).toHaveLength(1);
    expect(data.user[0]).toMatchObject({ id: login.user.id, name: "Reset name", role, banned: false });
    expect(data.session).toHaveLength(0);
    await expect(auth.api.signInUsername({ body: { username: role, password: input.password } })).rejects.toThrow();
    expect((await auth.api.signInUsername({ body: { username: role, password: "password" } })).user.id).toBe(login.user.id);
  });
  it("disables email login, sign-up and recovery over HTTP", async () => {
    const { auth } = fixture();
    await ensureBootstrapAdmin({ auth, username: "admin", password: "password", name: "Admin" });
    for (const path of ["/sign-in/email", "/sign-up/email", "/request-password-reset", "/reset-password", "/change-email", "/send-verification-email", "/verify-email"]) {
      const response = await auth.handler(new Request(`http://localhost:8080/api/auth${path}`, { method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:8080" },
        body: JSON.stringify({ email: "admin@users.guard.invalid", password: "password" }) }));
      expect(response.status, path).toBe(404);
    }
    const response = await auth.handler(new Request("http://localhost:8080/api/auth/sign-in/username", { method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:8080" }, body: JSON.stringify({ username: "admin", password: "password" }) }));
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().join(";")).toContain("tali-guard.session_token");
  });
  it("reapplies the same password after a Job revision changes and skips ordinary polls", async () => {
    const { auth, data } = fixture();
    const synchronizer = new BootstrapAccountSynchronizer(auth);
    const config = { bootstrapAdmin: { username: "admin", password: "password", name: "Admin", revision: "first" }, bootstrapUser: null };
    await synchronizer.synchronize(config);
    const login = await auth.api.signInUsername({ body: { username: "admin", password: "password" } });
    expect(await synchronizer.synchronize(config)).toEqual([]);
    expect(data.session).toHaveLength(1);
    const context = await auth.$context;
    await context.internalAdapter.updatePassword(login.user.id, await context.password.hash("changed-through-ui"));
    expect(await synchronizer.synchronize({ ...config, bootstrapAdmin: { ...config.bootstrapAdmin, revision: "rerun" } })).toEqual([
      { role: "admin", username: "admin", status: "updated" },
    ]);
    expect(data.session).toHaveLength(0);
    expect((await auth.api.signInUsername({ body: { username: "admin", password: "password" } })).user.id).toBe(login.user.id);
  });

  it("validates before creating an account", async () => {
    const { auth, data } = fixture();
    for (const input of [{ username: "admin@example.com", password: "password" }, { username: "admin", password: "short" }]) {
      await expect(ensureBootstrapAdmin({ auth, name: "Admin", ...input })).rejects.toThrow();
    }
    expect(data.user).toHaveLength(0);
  });
});
