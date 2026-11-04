import { internalAccountEmail, parseUsername } from "../../shared/username";
import { isAccountRole } from "../../shared/rbac";
import { authClient } from "@/lib/better-auth";
import { requestController } from "@/lib/controller-api";
import { setCurrentProjectId } from "@/lib/project-context";

export type SignInOptions = { password: boolean; sso: { providerId: string; displayName: string } | null };
export const getSignInOptions = () => requestController<SignInOptions>("/api/sign-in/options");
export const getAccountSignInMethod = async () => {
  const result = await authClient.listAccounts();
  if (result.error) throw new Error(result.error.message || "Sign-in method is unavailable.");
  return result.data?.some(account => account.providerId === "corporate-sso") ? "sso" as const : "password" as const;
};
export const loginSso = async (providerId: string) => {
  const callback = new URL(window.location.href);
  callback.searchParams.delete("sso_error");
  const callbackURL = `${callback.pathname}${callback.search}${callback.hash}`;
  callback.searchParams.set("sso_error", "1");
  const result = await authClient.signIn.social({ provider: providerId,
    callbackURL, errorCallbackURL: `${callback.pathname}${callback.search}${callback.hash}` });
  if (result.error) throw new Error(result.error.message || "SSO sign-in could not be started.");
};

export type IdentityRole = import("../../shared/rbac").AccountRole;
export type {IdentityUser,UserSummary,UserDetail} from "../../shared/identity";
import type {IdentityUser,UserSummary,UserDetail} from "../../shared/identity";
import type {DirectoryPage} from "../../shared/directory";
import {directorySearch,type PageQuery} from "./directory-query";
export type AuthStatus = { authenticated: boolean; user: IdentityUser | null };

export const getAuthStatus = async (): Promise<AuthStatus> => {
  // Recovery must agree with the API's current database-backed authority, not
  // the identity stored in the short-lived signed session cookie cache.
  const result = await authClient.getSession({ query: { disableCookieCache: true } });
  if (result.error) throw new Error(result.error.message || "Authentication status is unavailable.");
  const user = result.data ? identityUser(result.data.user,
    result.data.session && "activeProjectId" in result.data.session ? result.data.session.activeProjectId ?? null : undefined) : null;
  setCurrentProjectId(user?.project_id ?? null);
  return { authenticated: Boolean(result.data), user };
};

export const login = async (input: { username: string; password: string }) => {
  const username = parseUsername(input.username);
  const result = await authClient.signIn.username({ username, password: input.password });
  if (result.error) throw new Error(result.error.message || "Sign in failed.");
  if (!result.data?.user) throw new Error("Better Auth did not return the signed-in user.");
  // The session selects a project independently of the human user's default.
  const status = await getAuthStatus();
  if (!status.user) throw new Error("Better Auth did not create a session.");
  return { user: status.user };
};

export const logout = async () => {
  const result = await authClient.signOut();
  if (result.error) throw new Error(result.error.message || "Sign out failed.");
  setCurrentProjectId(null);
};

export const updateMe = async (input: { preferred_language?: "en" | "zh-CN" }) => {
  const result = await authClient.updateUser({
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

export const getUsers = (query:PageQuery = {},signal?:AbortSignal) => requestController<DirectoryPage<UserSummary>>(`/api/v1/users${directorySearch(query)}`,{signal});
export const getUser = (id:string,query:PageQuery = {},signal?:AbortSignal) => requestController<UserDetail>(`/api/v1/users/${encodeURIComponent(id)}${directorySearch(query)}`,{signal});

export const createUser = async (input: { username: string; password: string; role: IdentityRole; preferred_language: "en" | "zh-CN" }) => {
  const username = parseUsername(input.username);
  const result = await authClient.admin.createUser({
    name: "", // Required by Better Auth; discarded before storage.
    email: internalAccountEmail(username),
    password: input.password,
    role: input.role,
    data: { username, preferredLanguage: input.preferred_language },
  });
  if (result.error) throw new Error(result.error.message || "User creation failed.");
  return identityUser(result.data.user);
};

export const updateUser = async (id: string, input: { role?: IdentityRole; enabled?: boolean; password?: string }) => {
  if (input.role) {
    const result = await authClient.admin.setRole({ userId: id, role: input.role });
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
  return (await getUser(id)).user;
};

function identityUser(value: unknown, activeProjectId?: string | null): IdentityUser {
  const user = value as {
    id: string; username: string; email?: string; role?: string | null; banned?: boolean | null;
    preferredLanguage?: string | null; createdAt: Date | string; updatedAt?: Date | string;
    lastLoginAt?: Date | string | null;
  };
  const role = user.role ?? "user";
  if (!isAccountRole(role)) throw new Error("This account has an unsupported role. Contact an administrator.");
  const createdAt = new Date(user.createdAt).toISOString();
  return {
    id: user.id,
    ...(user.email ? { email: user.email } : {}),
    username: user.username,
    role,
    project_id: role === "user" ? activeProjectId ?? null : null,
    enabled: !user.banned,
    preferred_language: user.preferredLanguage === "zh-CN" ? "zh-CN" : "en",
    last_login_at: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : null,
    created_at: createdAt,
    updated_at: new Date(user.updatedAt ?? user.createdAt).toISOString(),
  };
}
