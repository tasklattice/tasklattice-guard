import { z } from "zod";
import { accountPermission } from "./rbac.js";

export const tokenModules = ["projects", "projectGroups", "providers", "models", "modelConfiguration", "modelPricing", "runners", "guardrails", "routers", "endpoints", "policies", "playground", "runtime", "audit"] as const;
export type TokenModule = typeof tokenModules[number];
export type TokenPermissions = Partial<Record<TokenModule, "read" | "write" | undefined>>;
export const readOnlyTokenModules: readonly TokenModule[] = ["runtime", "audit"];
const access = z.enum(["read", "write"]).optional();
export const tokenPermissionsSchema = z.strictObject({
  guardrails: access, routers: access, endpoints: access, policies: access,
  playground: access, models: access, runners: access,
  runtime: z.literal("read").optional(), audit: z.literal("read").optional(),
  providers: access, modelConfiguration: access, modelPricing: access, projects: access, projectGroups: access,
}).refine(value => Object.values(value).some(Boolean), "Select at least one module permission.");
export const createAccessTokenSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)]),
  permissions: tokenPermissionsSchema,
});
export type CreateAccessToken = z.infer<typeof createAccessTokenSchema>;
export type AccessTokenView = {
  id: string; name: string; prefix: string; permissions: TokenPermissions;
  projectId?: string | null;
  createdAt: string; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null;
};
export function accountModuleAccess(role: string | null | undefined, module: TokenModule): "read" | "write" | null {
  return accountPermission(role, module);
}

/** Retired or unknown grants never acquire authority through a replacement module. */
export function supportedTokenPermissions(permissions: TokenPermissions): TokenPermissions {
  return Object.fromEntries(tokenModules.flatMap(module => {
    const grant = permissions[module];
    return grant === "read" || grant === "write" ? [[module, grant]] : [];
  }));
}

export function effectiveTokenPermissions(permissions: TokenPermissions, role: string): TokenPermissions {
  return Object.fromEntries(Object.entries(supportedTokenPermissions(permissions)).flatMap(([module, grant]) => {
    const maximum = accountModuleAccess(role, module as TokenModule);
    return grant && maximum ? [[module, maximum === "read" ? "read" : grant]] : [];
  }));
}

export function allowsTokenPermission(permissions: TokenPermissions, module: TokenModule, access: "read" | "write", role: string) {
  const maximum = accountModuleAccess(role, module);
  if (!maximum || access === "write" && maximum !== "write") return false;
  const granted = permissions[module];
  return access === "read" ? granted === "read" || granted === "write" : granted === "write";
}
