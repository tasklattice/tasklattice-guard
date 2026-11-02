import { requestController } from "./controller-api";
import type { z } from "zod";
import type { groupModelConfigurationInput, GroupModelConfigurationView } from "../../shared/group-model-configuration";

export type { GroupModelConfigurationView } from "../../shared/group-model-configuration";

export type TenantGroup = {
  id: string; name: string; isDefault: boolean; createdAt: string; updatedAt: string;
  tenantIds: string[]; poolIds: string[];
};
export type GroupTenant = { id: string; name: string; groupId: string };
export type GroupRunnerPool = {
  id: string; name: string; groupId: string; isDefault: boolean;
  runtimeUrl: string | null; publicUrl: string | null;
  instances?: Array<{ runnerId: string; status: string }>;
};
export type TenantGroupDirectory = { items: TenantGroup[]; tenants: GroupTenant[]; pools: GroupRunnerPool[] };
export type PoolRegistration = { id: string; name: string; runtimeUrl: string; publicUrl?: string | null };
export const tenantGroupsKey = ["resources", "tenant-groups"] as const;
const groupPath = (id: string) => `/api/v1/tenant-groups/${encodeURIComponent(id)}`;
const poolPath = (id: string) => `/api/v1/runner-pools/${encodeURIComponent(id)}`;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const getTenantGroups = (signal?: AbortSignal) => requestController<TenantGroupDirectory>("/api/v1/tenant-groups", { signal });
export const createTenantGroup = (input: { id?: string; name: string }) => requestController<TenantGroup>("/api/v1/tenant-groups", json("POST", input));
export const renameTenantGroup = (id: string, name: string) => requestController<TenantGroup>(groupPath(id), json("PATCH", { name }));
export const deleteTenantGroup = (id: string) => requestController<void>(groupPath(id), { method: "DELETE" });
export const assignTenantGroup = (id: string, groupId: string, expectedGroupId: string) => requestController<GroupTenant>(`/api/v1/tenants/${encodeURIComponent(id)}/group`, json("PUT", { groupId, expectedGroupId }));
export const assignRunnerPoolGroup = (id: string, groupId: string, expectedGroupId: string) => requestController<GroupRunnerPool>(`${poolPath(id)}/group`, json("PUT", { groupId, expectedGroupId }));
export const registerGroupRunnerPool = (groupId: string, input: PoolRegistration) => requestController<GroupRunnerPool>(`${groupPath(groupId)}/pools`, json("POST", input));
export const updateRunnerPoolConnectivity = (id: string, input: { runtimeUrl: string | null; publicUrl: string | null }) => requestController<GroupRunnerPool>(`${poolPath(id)}/connectivity`, json("PUT", input));
export const groupModelConfigurationKey = (id: string) => [...tenantGroupsKey, id, "models"] as const;
export const getGroupModelConfiguration = (id: string, signal?: AbortSignal) => requestController<GroupModelConfigurationView>(`${groupPath(id)}/model-configuration`, { signal });
export const updateGroupModelConfiguration = (id: string, input: z.infer<typeof groupModelConfigurationInput>) => requestController<GroupModelConfigurationView>(`${groupPath(id)}/model-configuration`, json("PUT", input));
