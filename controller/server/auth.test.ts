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

describe("Guard sign-in throttling", () => {
  beforeEach(() => betterAuth.mockClear());

  it("keys login throttling by client address with a CLI-workable but bounded budget", () => {
    createAuth({
      publicUrl: "http://localhost:38081",
      betterAuthSecret: "guard-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:38081"],
      minPasswordLength: 8,
      trustedProxyCidrs: [],
    } as unknown as ControllerConfig, {} as ControllerDatabase);

    expect(betterAuth).toHaveBeenCalledWith(expect.objectContaining({
      rateLimit: {
        enabled: true,
        window: 60,
        max: 100,
        customRules: { "/sign-in/username": { window: 60, max: 10 } },
      },
      // No proxy is trusted, so the HTTP layer supplies the socket peer instead.
      advanced: { cookiePrefix: GUARD_AUTH_COOKIE_PREFIX },
    }));
  });

  it("lets Better Auth validate the forwarding chain only when proxies are configured", () => {
    createAuth({
      publicUrl: "http://localhost:38081",
      betterAuthSecret: "guard-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:38081"],
      minPasswordLength: 8,
      trustedProxyCidrs: ["10.0.0.0/8"],
    } as unknown as ControllerConfig, {} as ControllerDatabase);

    expect(betterAuth).toHaveBeenCalledWith(expect.objectContaining({
      advanced: { cookiePrefix: GUARD_AUTH_COOKIE_PREFIX, ipAddress: { trustedProxies: ["10.0.0.0/8"] } },
    }));
  });
});
