import { createLocalAccountIssuer } from "better-auth/db";

import type { ControllerAuth } from "./auth.js";
import { internalAccountEmail, usernameSchema } from "../shared/username.js";
import type { AccountRole } from "../shared/rbac.js";

type BootstrapAccountInput = {
  auth: ControllerAuth;
  username: string;
  password: string;
  name: string;
};

export function ensureBootstrapAdmin(input: BootstrapAccountInput) {
  return ensureBootstrapAccount(input, "admin");
}

export function ensureBootstrapUser(input: BootstrapAccountInput) {
  return ensureBootstrapAccount(input, "user");
}

async function ensureBootstrapAccount(input: BootstrapAccountInput, role: AccountRole): Promise<"created" | "updated"> {
  const username = usernameSchema.parse(input.username);
  const context = await input.auth.$context;
  if (!input.password || input.password.length < (context.options.emailAndPassword?.minPasswordLength ?? 8)) {
    throw new Error("Bootstrap password does not meet the configured minimum length.");
  }
  const existing = await context.adapter.findOne<{ id: string }>({ model: "user", where: [{ field: "username", value: username }] });
  if (!existing) {
    await input.auth.api.createUser({ body: {
      email: internalAccountEmail(username), password: input.password, name: input.name,
      role, data: { username },
    } });
    return "created";
  }

  // Bootstrap is authoritative: retain resource ownership, replace the login
  // through Better Auth, and revoke sessions created with the old credentials.
  const password = await context.password.hash(input.password);
  const accounts = await context.internalAdapter.findAccounts(existing.id);
  const credential = accounts.find(item => item.providerId === "credential" && item.issuer === createLocalAccountIssuer("credential"));
  if (credential) await context.internalAdapter.updatePassword(existing.id, password);
  else await context.internalAdapter.linkAccount({
    providerId: "credential", issuer: createLocalAccountIssuer("credential"),
    accountId: existing.id, userId: existing.id, password,
  });
  await context.internalAdapter.updateUser(existing.id, {
    name: input.name, role, banned: false, banReason: null, banExpires: null,
  });
  await context.internalAdapter.deleteUserSessions(existing.id);
  return "updated";
}

// One coordinator serves startup and mounted-Secret refreshes. A Job rerun
// changes revision even when it writes the same password as last time.
export class BootstrapAccountSynchronizer {
  private applied = new Map<string, string>();
  constructor(private readonly auth: ControllerAuth) {}

  async synchronize(config: { bootstrapAdmin: Omit<BootstrapAccountInput, "auth"> & { revision?: string } | null;
    bootstrapUser: Omit<BootstrapAccountInput, "auth"> & { revision?: string } | null }) {
    const results: { role: string; username: string; status: "created" | "updated" }[] = [];
    for (const [role, account, ensure] of [
      ["admin", config.bootstrapAdmin, ensureBootstrapAdmin],
      ["user", config.bootstrapUser, ensureBootstrapUser],
    ] as const) {
      if (!account) continue;
      const signature = JSON.stringify(account);
      if (this.applied.get(role) === signature) continue;
      const status = await ensure({ auth: this.auth, ...account });
      this.applied.set(role, signature);
      results.push({ role, username: account.username, status });
    }
    return results;
  }
}
