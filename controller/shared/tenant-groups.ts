import { z } from "zod";

export const DEFAULT_TENANT_GROUP_ID = "default";
export const tenantGroupIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  "Use a lowercase ID of up to 63 letters, numbers or hyphens.");
const name = z.string().trim().min(1).max(160);
export const runnerPoolOriginSchema = z.string().url().refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
    && !url.search && !url.hash && ["", "/"].includes(url.pathname);
}, "Use an HTTP(S) origin without credentials, a path, query or fragment.").transform(value => new URL(value).origin);

export const createTenantGroupSchema = z.strictObject({ id: tenantGroupIdSchema.optional(), name });
export const updateTenantGroupSchema = z.strictObject({ name });
export const tenantGroupAssignmentSchema = z.strictObject({ groupId: tenantGroupIdSchema, expectedGroupId: tenantGroupIdSchema });
export const createGroupPoolSchema = z.strictObject({
  id: tenantGroupIdSchema, name,
  runtimeUrl: runnerPoolOriginSchema,
  publicUrl: runnerPoolOriginSchema.nullable().optional(),
});
export const updatePoolConnectivitySchema = z.strictObject({
  runtimeUrl: runnerPoolOriginSchema.nullable(),
  publicUrl: runnerPoolOriginSchema.nullable(),
});

export type TenantGroupView = { id: string; name: string; isDefault: boolean; createdAt: string; updatedAt: string; tenantIds: string[]; poolIds: string[] };
export type TenantGroupMember = { id: string; name: string; groupId: string };
export type TenantGroupPool = { id: string; name: string; groupId: string; isDefault: boolean; runtimeUrl: string | null; publicUrl: string | null;
  desiredReplicas: number; safeRpsPerRunner: number; maxConcurrencyPerRunner: number };
export type TenantGroupInventory = { items: TenantGroupView[]; tenants: TenantGroupMember[]; pools: TenantGroupPool[] };
