import { z } from "zod";
import { reservedProjectPaths } from "./console-paths.js";

// Leave room for `runner-`, the separator and a ten-digit StatefulSet ordinal.
export const PROJECT_NAME_MAX_LENGTH = 45;
export const normalizeProjectName = (value: string) => value.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
export const canonicalProjectNameSchema = z.string().max(PROJECT_NAME_MAX_LENGTH)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens; start and end with a letter or number.");
export const projectNameSchema = z.string().transform(normalizeProjectName).pipe(canonicalProjectNameSchema)
  .refine(value => value !== "default", "default is reserved for the shared Runner pool.")
  .refine(value => !reservedProjectPaths.has(value), "This name is reserved for a console or service URL. Choose another project name.");
export const runnerPoolName = (projectName: string) => `runner-${projectName}`;
export function isRunnerName(value: string, projectName: string) {
  const prefix = `${runnerPoolName(projectName)}-`;
  if (!value.startsWith(prefix)) return false;
  const ordinal = value.slice(prefix.length);
  return /^(0|[1-9][0-9]*)$/.test(ordinal) && Number(ordinal) <= 2_147_483_647;
}
