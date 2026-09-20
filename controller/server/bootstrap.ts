import { eq } from "drizzle-orm";
import { createLocalAccountIssuer } from "better-auth/db";

import type { ControllerAuth } from "./auth.js";
import type { ControllerDatabase } from "./db/client.js";
import { account, user } from "./db/schema.js";
import { bootstrapPasswordHashPattern } from "./bootstrap-password.js";

export async function ensureBootstrapAdmin(input: {
  auth: ControllerAuth;
  db: ControllerDatabase;
  email: string;
  password?: string;
  passwordHash?: string;
  name: string;
}): Promise<"created" | "existing"> {
  if (Boolean(input.password) === Boolean(input.passwordHash)) {
    throw new Error("Configure exactly one bootstrap password or passwordHash.");
  }
  if (input.passwordHash && !bootstrapPasswordHashPattern.test(input.passwordHash)) {
    throw new Error("Bootstrap passwordHash must use Better Auth's scrypt format.");
  }
  const email = input.email.trim().toLowerCase();
  const [existing] = await input.db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  if (existing) {
    const linked = await input.db.select({ providerId: account.providerId }).from(account).where(eq(account.userId, existing.id));
    if (linked.some((item) => item.providerId === "credential")) return "existing";
    if (linked.length > 0) {
      throw new Error("Bootstrap administrator email is already linked to a non-credential Better Auth account.");
    }
    // Recover only an orphan left by an interrupted first bootstrap. Account
    // creation and password hashing below are still exclusively Better Auth's.
    await input.db.delete(user).where(eq(user.id, existing.id));
  }
  // Better Auth owns user creation and credential linking. The hash import is
  // startup-only and never changes the hashing behavior of public auth APIs.
  const created = await input.auth.api.createUser({
    body: { email, ...(input.password ? { password: input.password } : {}), name: input.name, role: "admin" },
  });
  if (input.passwordHash) {
    const context = await input.auth.$context;
    await context.internalAdapter.linkAccount({
      providerId: "credential",
      issuer: createLocalAccountIssuer("credential"),
      accountId: created.user.id,
      userId: created.user.id,
      password: input.passwordHash,
    });
  }
  return "created";
}
