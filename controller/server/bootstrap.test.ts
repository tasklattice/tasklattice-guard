// @vitest-environment node
import { readFile } from "node:fs/promises";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { describe, expect, it, vi } from "vitest";
import { ensureBootstrapAdmin } from "./bootstrap.js";
import type { ControllerAuth } from "./auth.js";
import type { ControllerDatabase } from "./db/client.js";

function fixture(existing = false) {
  const linkAccount = vi.fn();
  const createUser = vi.fn(async () => ({ user: { id: "bootstrap-user" } }));
  const select = vi.fn()
    .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => existing ? [{ id: "bootstrap-user" }] : [] }) }) })
    .mockReturnValueOnce({ from: () => ({ where: async () => [{ providerId: "credential" }] }) });
  const auth = { api: { createUser }, $context: Promise.resolve({ internalAdapter: { linkAccount } }) } as unknown as ControllerAuth;
  const db = { select } as unknown as ControllerDatabase;
  return { auth, db, createUser, linkAccount, select, email: "admin@example.test", name: "Administrator" };
}

describe("bootstrap credential import", () => {
  it("the development Values hash accepts the configured initial password", async () => {
    const values = await readFile(new URL("../../charts/tali-guard/values-dev.yaml", import.meta.url), "utf8");
    const hash = values.match(/passwordHash: "([a-f0-9:]+)"/)?.[1];
    expect(hash).toBeTruthy();
    expect(await verifyPassword({ hash: hash!, password: "password" })).toBe(true);
    expect(await verifyPassword({ hash: hash!, password: "Password" })).toBe(false);
  });

  it("imports a Better Auth hash without hashing it again", async () => {
    const input = fixture();
    const passwordHash = await hashPassword("password");
    expect(await ensureBootstrapAdmin({ ...input, passwordHash })).toBe("created");
    expect(input.createUser).toHaveBeenCalledWith({ body: { email: input.email, name: input.name, role: "admin" } });
    const credential = input.linkAccount.mock.calls[0]![0];
    expect(credential).toMatchObject({ providerId: "credential", accountId: "bootstrap-user", password: passwordHash });
    expect(await verifyPassword({ hash: credential.password, password: "password" })).toBe(true);
    expect(await verifyPassword({ hash: credential.password, password: passwordHash })).toBe(false);
  });

  it("does not replace existing credentials on restart", async () => {
    const input = fixture(true);
    expect(await ensureBootstrapAdmin({ ...input, passwordHash: await hashPassword("new-password") })).toBe("existing");
    expect(input.createUser).not.toHaveBeenCalled();
    expect(input.linkAccount).not.toHaveBeenCalled();
  });

  it("preserves the plaintext bootstrap API", async () => {
    const input = fixture();
    await ensureBootstrapAdmin({ ...input, password: "initial-password" });
    expect(input.createUser).toHaveBeenCalledWith({ body: { email: input.email, name: input.name, role: "admin", password: "initial-password" } });
    expect(input.linkAccount).not.toHaveBeenCalled();
  });

  it.each([{}, { passwordHash: "invalid" }, { password: "password", passwordHash: "hash" }])("rejects invalid or ambiguous configuration before writing: %j", async (credentials) => {
    const input = fixture();
    await expect(ensureBootstrapAdmin({ ...input, ...credentials })).rejects.toThrow();
    expect(input.select).not.toHaveBeenCalled();
    expect(input.createUser).not.toHaveBeenCalled();
  });
});
