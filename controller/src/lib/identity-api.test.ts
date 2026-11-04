import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { signInWithUsername, signInSocial, getSession, updateUser } = vi.hoisted(() => ({
  signInWithUsername: vi.fn(),
  signInSocial: vi.fn(),
  getSession: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock("@/lib/better-auth", () => ({
  authClient: {
    signIn: { username: signInWithUsername, social: signInSocial },
    getSession,
    updateUser,
  },
}));

import { getAuthStatus, login, loginSso, updateMe } from "@/lib/identity-api";

describe("SSO project return URLs", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));
  it("returns to the same project page, search and fragment", async () => {
    window.history.replaceState(null, "", "/test2/playground?guardrail=example&sso_error=1#result");
    signInSocial.mockResolvedValue({ error: null });
    await loginSso("corporate-sso");
    expect(signInSocial).toHaveBeenCalledWith({ provider: "corporate-sso", callbackURL: "/test2/playground?guardrail=example#result", errorCallbackURL: "/test2/playground?guardrail=example&sso_error=1#result" });
  });
});

const signedInUser = {
  id: "admin-id",
  username: "admin",
  role: "admin",
  projectId: null,
  banned: false,
  preferredLanguage: "zh-CN",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

describe("identity login", () => {
  beforeEach(() => {
    getSession.mockReset().mockResolvedValue({ data: { user: signedInUser }, error: null });
    signInWithUsername.mockReset();
    signInWithUsername.mockResolvedValue({ data: { user: signedInUser }, error: null });
  });

  it("checks current session state rather than a stale signed cookie", async () => {
    getSession.mockResolvedValue({ data: null, error: null });
    expect(await getAuthStatus()).toEqual({ authenticated: false, user: null });
    expect(getSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } });
  });

  it("uses the canonical user role instead of the retired member alias", async () => {
    getSession.mockResolvedValue({ data: { session: { activeProjectId: "projectB" }, user: { ...signedInUser, role: "user" } }, error: null });
    expect((await getAuthStatus()).user).toMatchObject({ role: "user", project_id: "projectB" });
  });
  it.each([undefined, null, "", "   ", 42])("keeps users without a selected project signed in for onboarding: %s", async (projectId) => {
    getSession.mockResolvedValue({ data: { user: { ...signedInUser, role: "user", projectId } }, error: null });
    expect((await getAuthStatus()).user).toMatchObject({ role: "user", project_id: null });
  });
  it("keeps platform administrators outside project scope", async () => {
    getSession.mockResolvedValue({ data: { user: { ...signedInUser, projectId: "projectA" } }, error: null });
    expect((await getAuthStatus()).user).toMatchObject({ role: "admin", project_id: null });
  });
  it("rejects an unsupported role instead of granting user authority", async () => {
    getSession.mockResolvedValue({ data: { user: { ...signedInUser, role: "unknown" } }, error: null });
    await expect(getAuthStatus()).rejects.toThrow("unsupported role");
  });
  it("signs in with the normalized username", async () => {
    await login({ username: " ADMIN ", password: "admin" });

    expect(signInWithUsername).toHaveBeenCalledWith({
      username: "admin",
      password: "admin",
    });
  });

  it("rejects email identifiers without sending a login request", async () => {
    await expect(login({ username: "Admin@Example.COM", password: "password" })).rejects.toThrow();
    expect(signInWithUsername).not.toHaveBeenCalled();
  });
});

describe("profile updates", () => {
  beforeEach(() => {
    updateUser.mockReset().mockResolvedValue({ data: { status: true }, error: null });
    getSession.mockReset().mockResolvedValue({ data: { user: signedInUser }, error: null });
  });

  it("reloads the user after the status-only update response", async () => {
    const result = await updateMe({ preferred_language: "zh-CN" });

    expect(updateUser).toHaveBeenCalledWith({ preferredLanguage: "zh-CN" });
    expect(getSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } });
    expect(result.user).toMatchObject({
      id: signedInUser.id,
      username: signedInUser.username,
      preferred_language: "zh-CN",
      created_at: signedInUser.createdAt,
      updated_at: signedInUser.updatedAt,
    });
  });

  it("reports update errors without trying to refresh the session", async () => {
    updateUser.mockResolvedValue({ data: null, error: { message: "Profile update failed." } });

    await expect(updateMe({ preferred_language: "zh-CN" })).rejects.toThrow("Profile update failed.");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("reports a session refresh error instead of parsing an invalid date", async () => {
    getSession.mockResolvedValue({ data: null, error: { message: "Authentication status is unavailable." } });

    await expect(updateMe({ preferred_language: "zh-CN" })).rejects.toThrow("Authentication status is unavailable.");
  });

  it("reports when the session ends after saving", async () => {
    getSession.mockResolvedValue({ data: null, error: null });

    await expect(updateMe({ preferred_language: "zh-CN" })).rejects.toThrow("Session ended after profile update.");
  });
});
