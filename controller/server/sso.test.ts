import { describe, expect, it } from "vitest";
import { loadSsoConfig } from "./sso-config.js";
import { relayEntitlements } from "./sso.js";

const config = { NODE_ENV: "production", CONTROLLER_SSO_ENABLED: "true", CONTROLLER_SSO_ISSUER: "https://idp.example/realms/tali", CONTROLLER_SSO_CLIENT_ID: "guard", CONTROLLER_SSO_CLIENT_SECRET: "test-only" };
describe("Keycloak configuration and path authority", () => {
  it("is disabled by default and validates configuration without echoing credentials", () => {
    expect(loadSsoConfig({})).toBeNull();
    expect(loadSsoConfig(config)).toMatchObject({ groupClaim: "groups", clientId: "guard" });
    expect(() => loadSsoConfig({ ...config, CONTROLLER_SSO_CLIENT_ID: "" })).toThrow("CONTROLLER_SSO_CLIENT_ID");
  });
  it.each(["http://idp.example", "https://user:password@idp.example", "https://idp.example?secret=x", "ftp://idp.example", "broken"])("rejects unsafe issuer %s", issuer => {
    expect(() => loadSsoConfig({ ...config, CONTROLLER_SSO_ISSUER: issuer })).toThrow();
  });
  it("does not infer authority from parents, prefixes, unknown roles or forged structures", () => {
    expect(relayEntitlements(["/tali", "/tali/r/ROLE_PLATFORM_ADMIN/child", "/tali/d/d1/r/ROLE_DEPARTMENT_ADMIN", "/tali/d/d1/p/p1/r/ADMIN"]))
      .toEqual({ platformAdmin: false, projects: [] });
    expect(() => relayEntitlements({ roles: ["admin"] })).toThrow();
    expect(() => relayEntitlements([7])).toThrow();
  });
  it("combines multiple roles without confusing project and platform administration", () => {
    expect(relayEntitlements(["/tali/d/d1/p/p1/r/ROLE_AUDITOR", "/tali/d/d1/p/p1/r/ROLE_PROJECT_ADMIN"]))
      .toMatchObject({ platformAdmin: false, projects: [{ projectId: "p1", departmentId: "d1", access: "write", roles: ["ROLE_AUDITOR", "ROLE_PROJECT_ADMIN"] }] });
    expect(() => relayEntitlements(["/tali/d/d1/p/p1/r/ROLE_USER", "/tali/d/d2/p/p1/r/ROLE_USER"])).toThrow();
  });
});
