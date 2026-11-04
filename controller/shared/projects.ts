import { z } from "zod";
import { projectNameSchema } from "./runner-naming.js";

export const projectIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const createProjectSchema = z.strictObject({
  name: projectNameSchema, groupId: projectIdSchema.default("default"),
  externalDepartmentId: projectIdSchema.optional(),
});
export type Project = { id: string; name: string; groupId: string; externalDepartmentId?: string | null; access?: "read" | "write"; roles?: string[] };
export type ProjectMember = { userId: string; username: string | null; email: string; source: string; access: "read" | "write"; roles: string[] };
export type ProjectSummary = Project & {groupName:string;poolId:string|null;poolName:string|null;memberCount:number};
export type ProjectAccessStatus = {
  state: "ready" | "project_required" | "project_missing" | "runner_uninitialized";
  projectId: string | null;
  missingProjects: Array<{projectId: string; departmentId: string}>;
};
