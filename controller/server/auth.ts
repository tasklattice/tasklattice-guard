import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, genericOAuth, username } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { and, eq } from "drizzle-orm";

import type { ControllerConfig } from "./config.js";
import type { ControllerDatabase } from "./db/client.js";
import { account, projectMembers, session, user, verification } from "./db/schema.js";
import { synchronizeSsoMemberships } from "./services/sso-memberships.js";
import { oidcProvider } from "./sso.js";
import { SSO_PROVIDER_ID } from "./sso-config.js";
import { internalAccountEmail, normalizeUsername, usernamePattern } from "../shared/username.js";

export const GUARD_AUTH_COOKIE_PREFIX = "tali-guard";

// Login throttling is only useful when it can tell clients apart.
export const SIGN_IN_RATE_LIMIT = { window: 60, max: 10 } as const;

export function createAuth(config: ControllerConfig, db: ControllerDatabase, includeSso = false) {
  const trustedProxies = config.trustedProxyCidrs ?? [];
  const sso = includeSso ? config.sso : null;
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
      "/link-social", "/unlink-account",
    ],
    account: { accountLinking: { enabled: false } },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: { activeProjectId: { type: "string", required: false, input: false } },
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
        update: {
          before: async (changes, context) => {
            if (changes.role !== undefined && context?.path?.startsWith("/admin/") && typeof context.body?.userId === "string") {
              const [external] = await db.select({ id: account.id }).from(account)
                .where(and(eq(account.userId, context.body.userId), eq(account.providerId, SSO_PROVIDER_ID))).limit(1);
              if (external) throw new APIError("FORBIDDEN", { message: "Manage SSO roles through Keycloak group paths." });
            }
            return { data: changes };
          },
        },
        create: {
          before: async (created, context) => {
            if (sso && context?.path === "/callback/:id" && context.params?.id === SSO_PROVIDER_ID) {
              return { data: { ...created, role: "user", emailVerified: true } };
            }
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
          before: async (created, context) => {
            if (!(sso && context?.path === "/callback/:id" && context.params?.id === SSO_PROVIDER_ID)) {
              const [external] = await db.select({ id: account.id }).from(account)
                .where(and(eq(account.userId, created.userId), eq(account.providerId, SSO_PROVIDER_ID))).limit(1);
              if (external) throw new APIError("FORBIDDEN", { message: "Use Keycloak to sign in to this account." });
            }
            if (sso && context?.path === "/callback/:id" && context.params?.id === SSO_PROVIDER_ID) {
              const [identity] = await db.select({ idToken: account.idToken }).from(account)
                .where(and(eq(account.userId, created.userId), eq(account.providerId, SSO_PROVIDER_ID), eq(account.issuer, sso.issuer))).limit(1);
              if (!identity?.idToken) throw new APIError("FORBIDDEN", { message: "Verified SSO identity is missing." });
              const claims = JSON.parse(Buffer.from(identity.idToken.split(".")[1]!, "base64url").toString("utf8"));
              await synchronizeSsoMemberships(db, created.userId, claims[sso.groupClaim]);
            }
            const [owner] = await db.select({ role: user.role }).from(user).where(eq(user.id, created.userId)).limit(1);
            const expiresAt = sso ? new Date(Math.min(created.expiresAt.getTime(), Date.now() + 60 * 60 * 1000)) : created.expiresAt;
            if (owner?.role !== "user") return { data: { ...created, activeProjectId: null, expiresAt } };
            const memberships = await db.select({ projectId: projectMembers.projectId }).from(projectMembers)
              .where(eq(projectMembers.userId, created.userId)).orderBy(projectMembers.projectId).limit(1);
            const projectId = memberships[0]?.projectId ?? null;
            return { data: { ...created, activeProjectId: projectId, expiresAt } };
          },
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
      ...(sso ? [genericOAuth({ config: [oidcProvider(sso)] })] : []),
    ],
  });
}

export type ControllerAuth = ReturnType<typeof createAuth>;

/** Keep local sign-in and existing sessions available when the IdP is down.
 * Only SSO entry/callback requests initialize discovery; retry after failures. */
export function createSsoHandler(config: ControllerConfig, db: ControllerDatabase) {
  let pending: Promise<ControllerAuth> | undefined;
  return async (request: Request): Promise<Response> => {
    if (!config.sso) return Response.json({ error: { code: "sso_disabled", message: "SSO is not configured." } }, { status: 404 });
    pending ??= (async () => {
      const instance = createAuth(config, db, true);
      await instance.$context;
      return instance;
    })().catch(error => { pending = undefined; throw error; });
    let instance: ControllerAuth;
    try { instance = await pending; }
    catch { return Response.json({ error: { code: "sso_unavailable", message: "The identity provider is unavailable. Retry or use local sign-in." } }, { status: 503 }); }
    return instance.handler(request);
  };
}
