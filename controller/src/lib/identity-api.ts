import { authClient } from "@/lib/better-auth";

export type IdentityRole = "admin" | "member";
export type IdentityUser = {
  id: string;
  display_name: string;
  email: string;
  role: IdentityRole;
  enabled: boolean;
  preferred_language: "en" | "zh-CN";
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};
export type AuthStatus = { authenticated: boolean; user: IdentityUser | null };

export const getAuthStatus = async (): Promise<AuthStatus> => {
  // Recovery must agree with the API's current database-backed authority, not
  // the identity stored in the short-lived signed session cookie cache.
  const result = await authClient.getSession({ query: { disableCookieCache: true } });
  if (result.error) throw new Error(result.error.message || "Authentication status is unavailable.");
  return { authenticated: Boolean(result.data), user: result.data ? identityUser(result.data.user) : null };
};

export const login = async (input: { email: string; password: string }) => {
  const identifier = input.email.trim().toLowerCase();
  const email = identifier.includes("@") ? identifier : `${identifier}@tasklattice.local`;
  const result = await authClient.signIn.email({ email, password: input.password });
  if (result.error) throw new Error(result.error.message || "Sign in failed.");
  if (!result.data?.user) throw new Error("Better Auth did not return the signed-in user.");
  return { user: identityUser(result.data.user) };
};

export const logout = async () => {
  const result = await authClient.signOut();
  if (result.error) throw new Error(result.error.message || "Sign out failed.");
};

export const updateMe = async (input: { display_name?: string; preferred_language?: "en" | "zh-CN" }) => {
  const result = await authClient.updateUser({
    ...(input.display_name ? { name: input.display_name } : {}),
    ...(input.preferred_language ? { preferredLanguage: input.preferred_language } : {}),
  });
  if (result.error) throw new Error(result.error.message || "Profile update failed.");
  // updateUser returns only a status; reload the persisted user from the session.
  const session = await getAuthStatus();
  if (!session.user) throw new Error("Session ended after profile update.");
  return { user: session.user };
};

export const changePassword = async (input: { current_password: string; new_password: string }) => {
  const result = await authClient.changePassword({
    currentPassword: input.current_password,
    newPassword: input.new_password,
    revokeOtherSessions: true,
  });
  if (result.error) throw new Error(result.error.message || "Password update failed.");
  const session = await getAuthStatus();
  if (!session.user) throw new Error("Session ended after password update.");
  return { user: session.user };
};

export const getUsers = async () => {
  const users: unknown[] = [];
  for (let offset = 0; offset < 10_000; offset += 100) {
    const result = await authClient.admin.listUsers({ query: { limit: 100, offset, sortBy: "createdAt", sortDirection: "desc" } });
    if (result.error) throw new Error(result.error.message || "Users could not be loaded.");
    const page = result.data?.users ?? [];
    users.push(...page);
    if (page.length < 100) break;
  }
  return { users: users.map(identityUser) };
};

export const createUser = async (input: { display_name: string; email: string; password: string; role: IdentityRole; preferred_language: "en" | "zh-CN" }) => {
  const result = await authClient.admin.createUser({
    name: input.display_name,
    email: input.email,
    password: input.password,
    role: input.role === "admin" ? "admin" : "user",
    data: { preferredLanguage: input.preferred_language },
  });
  if (result.error) throw new Error(result.error.message || "User creation failed.");
  return identityUser(result.data.user);
};

export const updateUser = async (id: string, input: { display_name?: string; role?: IdentityRole; enabled?: boolean; password?: string }) => {
  if (input.display_name) {
    const result = await authClient.admin.updateUser({ userId: id, data: { name: input.display_name } });
    if (result.error) throw new Error(result.error.message || "User update failed.");
  }
  if (input.role) {
    const result = await authClient.admin.setRole({ userId: id, role: input.role === "admin" ? "admin" : "user" });
    if (result.error) throw new Error(result.error.message || "Role update failed.");
  }
  if (input.enabled !== undefined) {
    const result = input.enabled
      ? await authClient.admin.unbanUser({ userId: id })
      : await authClient.admin.banUser({ userId: id, banReason: "Disabled by an administrator." });
    if (result.error) throw new Error(result.error.message || "Account status update failed.");
  }
  if (input.password) {
    const result = await authClient.admin.setUserPassword({ userId: id, newPassword: input.password });
    if (result.error) throw new Error(result.error.message || "Password reset failed.");
  }
  const users = await getUsers();
  const updated = users.users.find((item) => item.id === id);
  if (!updated) throw new Error("Updated user was not returned by Better Auth.");
  return updated;
};

function identityUser(value: unknown): IdentityUser {
  const user = value as {
    id: string; name: string; email: string; role?: string | null; banned?: boolean | null;
    preferredLanguage?: string | null; createdAt: Date | string; updatedAt?: Date | string;
    lastLoginAt?: Date | string | null;
  };
  const createdAt = new Date(user.createdAt).toISOString();
  return {
    id: user.id,
    display_name: user.name,
    email: user.email,
    role: user.role === "admin" ? "admin" : "member",
    enabled: !user.banned,
    preferred_language: user.preferredLanguage === "zh-CN" ? "zh-CN" : "en",
    last_login_at: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : null,
    created_at: createdAt,
    updated_at: new Date(user.updatedAt ?? user.createdAt).toISOString(),
  };
}
