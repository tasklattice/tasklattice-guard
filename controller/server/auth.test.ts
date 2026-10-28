import { beforeEach, describe, expect, it, vi } from "vitest";

const { betterAuth, drizzleAdapter, admin, username } = vi.hoisted(() => ({
  betterAuth: vi.fn((options: unknown) => options),
  drizzleAdapter: vi.fn(() => "database-adapter"),
  admin: vi.fn(() => "admin-plugin"),
  username: vi.fn(() => "username-plugin"),
}));

vi.mock("better-auth", () => ({ betterAuth }));
vi.mock("better-auth/adapters/drizzle", () => ({ drizzleAdapter }));
vi.mock("better-auth/plugins", () => ({ admin, username }));

import { createAuth, GUARD_AUTH_COOKIE_PREFIX } from "./auth.js";
import type { ControllerConfig } from "./config.js";
import type { ControllerDatabase } from "./db/client.js";

describe("Guard Better Auth", () => {
  beforeEach(() => {
    betterAuth.mockClear();
    drizzleAdapter.mockClear();
    admin.mockClear();
  });

  it("uses a Guard-specific cookie prefix so localhost services cannot overwrite its session", () => {
    createAuth({
      publicUrl: "http://localhost:38081",
      betterAuthSecret: "guard-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:38081"],
      minPasswordLength: 12,
    } as ControllerConfig, {} as ControllerDatabase);

    expect(admin).toHaveBeenCalledWith(expect.objectContaining({ defaultRole: "user", adminRoles: ["admin"], roles: { admin: expect.any(Object), user: expect.any(Object) } }));
    expect(GUARD_AUTH_COOKIE_PREFIX).toBe("tali-guard");
    expect(betterAuth).toHaveBeenCalledWith(expect.objectContaining({
      advanced: { cookiePrefix: "tali-guard" },
    }));
  });
});
