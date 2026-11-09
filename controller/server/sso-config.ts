import { z } from "zod";

export const SSO_PROVIDER_ID = "corporate-sso";

export type SsoConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  displayName: string;
  groupClaim: string;
  allowedEmailDomains: string[];
};

export function loadSsoConfig(environment: NodeJS.ProcessEnv): SsoConfig | null {
  if (environment.CONTROLLER_SSO_ENABLED !== "true") {
    if (environment.CONTROLLER_SSO_ENABLED && environment.CONTROLLER_SSO_ENABLED !== "false") {
      throw new Error("CONTROLLER_SSO_ENABLED must be true or false.");
    }
    return null;
  }
  const required = (name: string) => {
    const value = environment[name]?.trim();
    if (!value) throw new Error(`${name} is required when SSO is enabled.`);
    return value;
  };
  const issuer = required("CONTROLLER_SSO_ISSUER").replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(issuer); } catch { throw new Error("CONTROLLER_SSO_ISSUER must be an absolute HTTPS URL."); }
  const localHttp = environment.NODE_ENV !== "production" && url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search || url.hash) {
    throw new Error("CONTROLLER_SSO_ISSUER requires HTTPS without credentials, query or fragment (loopback HTTP is allowed outside production).");
  }
  const allowedEmailDomains = (environment.CONTROLLER_SSO_ALLOWED_EMAIL_DOMAINS ?? "")
    .split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (allowedEmailDomains.some(domain => !z.hostname().safeParse(domain).success || domain.includes("@"))) {
    throw new Error("CONTROLLER_SSO_ALLOWED_EMAIL_DOMAINS must contain bare email domains.");
  }
  return {
    issuer, clientId: required("CONTROLLER_SSO_CLIENT_ID"), clientSecret: required("CONTROLLER_SSO_CLIENT_SECRET"),
    displayName: environment.CONTROLLER_SSO_DISPLAY_NAME?.trim() || "Company SSO",
    groupClaim: environment.CONTROLLER_SSO_GROUP_CLAIM?.trim() || "groups", allowedEmailDomains,
  };
}
