import { createHash } from "node:crypto";
import { APIError } from "better-auth/api";
import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { SSO_PROVIDER_ID, type SsoConfig } from "./sso-config.js";

export function oidcProvider(config: SsoConfig): GenericOAuthConfig {
  return {
    providerId: SSO_PROVIDER_ID,
    name: config.displayName,
    discoveryUrl: `${config.issuer}/.well-known/openid-configuration`,
    accountIssuer: config.issuer,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes: ["openid", "profile", "email"],
    pkce: true,
    requireIdTokenVerification: true,
    disableProviderLogout: true,
    // Better Auth verifies the signature, audience, expiry and nonce before
    // invoking getUserInfo. Require that verified token, with the configured
    // issuer, rather than falling back to an OAuth-only userinfo response.
    getUserInfo: async tokens => {
      if (!tokens.idToken) throw new APIError("UNAUTHORIZED", { message: "A verified OIDC ID token is required." });
      let claims: Record<string, unknown>;
      try { claims = JSON.parse(Buffer.from(tokens.idToken.split(".")[1]!, "base64url").toString("utf8")); }
      catch { throw new APIError("UNAUTHORIZED", { message: "Invalid OIDC identity." }); }
      if (claims.iss !== config.issuer || typeof claims.sub !== "string" || !claims.sub.trim()
        || typeof claims.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)
        || claims.email_verified !== true) {
        throw new APIError("UNAUTHORIZED", { message: "SSO requires an identity from the configured issuer with a verified email address." });
      }
      const email = claims.email.toLowerCase();
      if (config.allowedEmailDomains.length && !config.allowedEmailDomains.includes(email.split("@")[1]!)) {
        throw new APIError("FORBIDDEN", { message: "This email domain is not allowed to sign in." });
      }
      relayEntitlements(claims[config.groupClaim]);
      return { sub: claims.sub, id: claims.sub, email, emailVerified: true,
        name: typeof claims.name === "string" && claims.name.trim() ? claims.name : email };
    },
    mapProfileToUser: profile => ({
      name: profile.name || profile.email!,
      email: profile.email!,
      emailVerified: true,
      username: `sso-${createHash("sha256").update(`${config.issuer}\0${profile.sub}`).digest("hex").slice(0, 40)}`,
      role: "user",
    }),
  };
}

export type RelayProjectGrant = { projectId: string; departmentId: string; roles: string[]; access: "read" | "write" };
export function relayEntitlements(value: unknown): { platformAdmin: boolean; projects: RelayProjectGrant[] } {
  const groups = value == null ? [] : typeof value === "string" ? [value] : value;
  if (!Array.isArray(groups) || groups.some(group => typeof group !== "string")) throw new APIError("FORBIDDEN", { message: "The OIDC groups claim must contain group paths." });
  const projects = new Map<string, RelayProjectGrant>();
  for (const path of groups) {
    const match = /^\/tali\/d\/([a-zA-Z0-9_-]{1,128})\/p\/([a-zA-Z0-9_-]{1,128})\/r\/(ROLE_PROJECT_ADMIN|ROLE_AGENT_DEVELOPER|ROLE_AUDITOR|ROLE_REVIEWER|ROLE_USER)$/.exec(path);
    if (!match) continue;
    const departmentId = match[1]!; const projectId = match[2]!; const role = match[3]!;
    const existing = projects.get(projectId);
    if (existing && existing.departmentId !== departmentId) throw new APIError("FORBIDDEN", { message: "A project cannot belong to two departments." });
    const grant = existing ?? { projectId, departmentId, roles: [], access: "read" };
    if (!grant.roles.includes(role)) grant.roles.push(role);
    if (role === "ROLE_PROJECT_ADMIN" || role === "ROLE_AGENT_DEVELOPER") grant.access = "write";
    projects.set(projectId, grant);
  }
  return { platformAdmin: groups.includes("/tali/r/ROLE_PLATFORM_ADMIN"), projects: [...projects.values()] };
}
