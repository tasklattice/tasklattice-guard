import { beforeEach, describe, expect, it, vi } from "vitest";

const { signInWithEmail, getSession, updateUser } = vi.hoisted(() => ({
  signInWithEmail: vi.fn(),
  getSession: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock("@/lib/better-auth", () => ({
  authClient: {
    signIn: { email: signInWithEmail },
    getSession,
    updateUser,
  },
}));

import { getAuthStatus, login, updateMe } from "@/lib/identity-api";

const signedInUser = {
  id: "admin-id",
  name: "Administrator",
  email: "admin@tasklattice.local",
  role: "admin",
  banned: false,
  preferredLanguage: "zh-CN",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

describe("identity login", () => {
  beforeEach(() => {
    getSession.mockReset();
    signInWithEmail.mockReset();
    signInWithEmail.mockResolvedValue({ data: { user: signedInUser }, error: null });
  });

  it("checks current session state rather than a stale signed cookie", async () => {
    getSession.mockResolvedValue({ data: null, error: null });
    expect(await getAuthStatus()).toEqual({ authenticated: false, user: null });
    expect(getSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } });
  });

  it("maps the admin username alias to the internal Better Auth email", async () => {
    await login({ email: " ADMIN ", password: "admin" });

    expect(signInWithEmail).toHaveBeenCalledWith({
      email: "admin@tasklattice.local",
      password: "admin",
    });
  });

  it("passes an explicit email to Better Auth after normalizing it", async () => {
    await login({ email: " Admin@Example.COM ", password: "a-secure-password" });

    expect(signInWithEmail).toHaveBeenCalledWith({
      email: "admin@example.com",
      password: "a-secure-password",
    });
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
      display_name: signedInUser.name,
      preferred_language: "zh-CN",
      created_at: signedInUser.createdAt,
      updated_at: signedInUser.updatedAt,
    });
  });

  it("saves the display name and language without timezone preferences", async () => {
    getSession.mockResolvedValue({ data: { user: { ...signedInUser, name: "Guard Operator" } }, error: null });

    const result = await updateMe({ display_name: "Guard Operator", preferred_language: "zh-CN" });

    expect(updateUser).toHaveBeenCalledWith({ name: "Guard Operator", preferredLanguage: "zh-CN" });
    expect(result.user.display_name).toBe("Guard Operator");
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
