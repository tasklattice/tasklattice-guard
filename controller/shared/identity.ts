import type { AccountRole } from "./rbac.js";
import type { DirectoryPage } from "./directory.js";
export type IdentityUser = {
  id: string; username: string; email?: string;
  role: AccountRole; project_id: string | null; enabled: boolean;
  preferred_language: "en" | "zh-CN"; last_login_at: string | null; created_at: string; updated_at: string;
};
export type UserSummary = Pick<IdentityUser,"id" | "username" | "role" | "enabled"> & {
  source: "sso" | "local"; projectCount: number;
};
export type UserDetail = { user: IdentityUser; source: "sso" | "local"; projects: DirectoryPage<{id:string;name:string}> };
