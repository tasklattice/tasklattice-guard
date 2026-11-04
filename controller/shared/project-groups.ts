import { z } from "zod";
import { projectIdSchema } from "./projects.js";

export const DEFAULT_PROJECT_GROUP_ID = "default";
export const projectGroupIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  "Use a lowercase ID of up to 63 letters, numbers or hyphens.");
const name = z.string().trim().min(1).max(160);
export const runnerPoolOriginSchema = z.string().url().refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
    && !url.search && !url.hash && ["", "/"].includes(url.pathname);
}, "Use an HTTP(S) origin without credentials, a path, query or fragment.").transform(value => new URL(value).origin);

export const createProjectGroupSchema = z.strictObject({ id: projectGroupIdSchema.optional(), name });
export const updateProjectGroupSchema = z.strictObject({ name });
export const projectGroupAssignmentSchema = z.strictObject({ groupId: projectGroupIdSchema, expectedGroupId: projectGroupIdSchema });
export const createGroupPoolSchema = z.strictObject({
  projectId: projectIdSchema,
  runtimeUrl: runnerPoolOriginSchema,
  publicUrl: runnerPoolOriginSchema.nullable().optional(),
});
export const updatePoolConnectivitySchema = z.strictObject({
  runtimeUrl: runnerPoolOriginSchema.nullable(),
  publicUrl: runnerPoolOriginSchema.nullable(),
});

const allocationVersion = {
  expectedGroupId: projectGroupIdSchema,
  expectedPoolId: projectIdSchema.nullable(),
};
export const projectRunnerConfigurationSchema = z.discriminatedUnion("mode", [
  z.strictObject({ ...allocationVersion, mode: z.literal("shared") }),
  z.strictObject({
    ...allocationVersion,
    mode: z.literal("dedicated"),
    runtimeUrl: runnerPoolOriginSchema,
    publicUrl: runnerPoolOriginSchema.nullable(),
  }),
]);
export type ProjectRunnerConfiguration = z.infer<typeof projectRunnerConfigurationSchema>;
export type ProjectRunnerView = {
  projectId: string;
  projectName: string;
  groupId: string;
  pool: (ProjectGroupPool & { connectedCount: number }) | null;
  modelScope: { projectCount: number; poolCount: number };
};

export type ProjectGroupView = { id: string; name: string; isDefault: boolean; createdAt: string; updatedAt: string; projectCount: number; poolCount: number };
export type ProjectGroupMember = { id: string; name: string; groupId: string };
export type ProjectGroupPool = { id: string; name: string; projectId: string | null; groupId: string; isDefault: boolean; runtimeUrl: string | null; publicUrl: string | null;
  desiredReplicas: number; safeRpsPerRunner: number; maxConcurrencyPerRunner: number };
