import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, username } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { eq } from "drizzle-orm";

import type { ControllerConfig } from "./config.js";
import type { ControllerDatabase } from "./db/client.js";
import { account, session, user, verification } from "./db/schema.js";
import { internalAccountEmail, normalizeUsername, usernamePattern } from "../shared/username.js";

export const GUARD_AUTH_COOKIE_PREFIX = "tali-guard";

// Login throttling is only useful when it can tell clients apart.
export const SIGN_IN_RATE_LIMIT = { window: 60, max: 10 } as const;

export function createAuth(config: ControllerConfig, db: ControllerDatabase) {
  const trustedProxies = config.trustedProxyCidrs ?? [];
  return betterAuth({
    appName: "TaskLattice Guard",
    baseURL: config.publicUrl,
    basePath: "/api/auth",
    secret: config.betterAuthSecret,
    trustedOrigins: config.trustedOrigins,
    advanced: {
      cookiePrefix: GUARD_AUTH_COOKIE_PREFIX,
      // Only a configured proxy may supply the client address; otherwise the
      // HTTP layer replaces the header with the socket peer (see http/app.ts).
      ...(trustedProxies.length ? { ipAddress: { trustedProxies } } : {}),
    },
    rateLimit: {
      enabled: true,
      // Auth paths are keyed by resolved client address. Every CLI command or
      // browser sign-in consumes one attempt, so the default 3-per-10s rule
      // throttles legitimate setup work. Keep a bounded per-client budget that
      // still resists online password guessing.
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/username": { ...SIGN_IN_RATE_LIMIT },
      },
    },
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: config.minPasswordLength,
      autoSignIn: true,
    },
    disabledPaths: [
      "/sign-in/email", "/sign-up/email", "/change-email",
      "/request-password-reset", "/reset-password",
      "/send-verification-email", "/verify-email",
    ],
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60,
      cookieCache: { enabled: false },
    },
    user: {
      additionalFields: {
        preferredLanguage: {
          type: "string",
          required: false,
          defaultValue: "en",
          input: true,
        },
        lastLoginAt: {
          type: "date",
          required: false,
          input: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (created, context) => {
            if (context?.path === "/admin/create-user") {
              const password = context.body?.password;
              if (typeof password !== "string" || password.length < config.minPasswordLength || password.length > 128) {
                throw new APIError("BAD_REQUEST", { message: `A password of ${config.minPasswordLength}–128 characters is required.` });
              }
            }
            const value: unknown = (created as typeof created & { username?: unknown }).username;
            const identifier = typeof value === "string" ? normalizeUsername(value) : "";
            if (!usernamePattern.test(identifier)) throw new APIError("BAD_REQUEST", { message: "A valid username is required." });
            return { data: { ...created, username: identifier, email: internalAccountEmail(identifier) } };
          },
        },
      },
      session: {
        create: {
          after: async (created) => {
            await db.update(user).set({ lastLoginAt: new Date() }).where(eq(user.id, created.userId));
          },
        },
      },
    },
    plugins: [
      username({ displayUsername: false, immutableUsername: true, minUsernameLength: 3, maxUsernameLength: 64,
        usernameNormalization: normalizeUsername, usernameValidator: value => usernamePattern.test(normalizeUsername(value)) }),
      admin({ defaultRole: "user", adminRoles: ["admin"], roles: { admin: adminAc, user: userAc } }),
    ],
  });
}

export type ControllerAuth = ReturnType<typeof createAuth>;
