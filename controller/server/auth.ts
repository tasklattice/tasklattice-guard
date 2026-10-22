import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { eq } from "drizzle-orm";

import type { ControllerConfig } from "./config.js";
import type { ControllerDatabase } from "./db/client.js";
import { account, session, user, verification } from "./db/schema.js";

export const GUARD_AUTH_COOKIE_PREFIX = "tali-guard";

export function createAuth(config: ControllerConfig, db: ControllerDatabase) {
  return betterAuth({
    appName: "TaskLattice Guard",
    baseURL: config.publicUrl,
    basePath: "/api/auth",
    secret: config.betterAuthSecret,
    trustedOrigins: config.trustedOrigins,
    advanced: {
      cookiePrefix: GUARD_AUTH_COOKIE_PREFIX,
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
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60,
      cookieCache: { enabled: true, maxAge: 60 * 5 },
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
        tenantId: {
          type: "string",
          required: false,
          defaultValue: "tenantA",
          input: false,
        },
      },
    },
    databaseHooks: {
      session: {
        create: {
          after: async (created) => {
            await db.update(user).set({ lastLoginAt: new Date() }).where(eq(user.id, created.userId));
          },
        },
      },
    },
    plugins: [admin({ defaultRole: "user", adminRoles: ["admin"], roles: { admin: adminAc, user: userAc } })],
  });
}

export type ControllerAuth = ReturnType<typeof createAuth>;
