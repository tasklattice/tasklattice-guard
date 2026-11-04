import type { DirectoryPage } from "../../shared/directory";
import { directorySearch, type PageQuery } from "./directory-query";
import { requestController } from "./controller-api";
import type {
  ProjectSummary,
  Project,
  ProjectMember,
  ProjectAccessStatus,
} from "../../shared/projects";

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
export const listMyProjects = (query: PageQuery = {}, signal?: AbortSignal) =>
  requestController<DirectoryPage<ProjectSummary>>(
    `/api/v1/account/projects${directorySearch(query)}`,
    { signal },
  );
export const selectProject = (projectId: string) =>
  requestController("/api/v1/account/project", json("PUT", { projectId }));
export const listProjects = (
  query: PageQuery & { groupId?: string; withoutPool?: boolean } = {},
  signal?: AbortSignal,
) =>
  requestController<DirectoryPage<ProjectSummary>>(
    `/api/v1/projects${directorySearch(query)}`,
    { signal },
  );
export const createProject = (input: {
  name: string;
  externalDepartmentId?: string;
}) => requestController<Project>("/api/v1/projects", json("POST", input));
export const getProjectAccess = () =>
  requestController<ProjectAccessStatus>("/api/v1/account/project-access");
export const refreshProjectAccess = () =>
  requestController<ProjectAccessStatus>(
    "/api/v1/account/project-access/refresh",
    json("POST", {}),
  );
export const listProjectMembers = (
  id: string,
  query: PageQuery = {},
  signal?: AbortSignal,
) =>
  requestController<DirectoryPage<ProjectMember>>(
    `/api/v1/projects/${encodeURIComponent(id)}/members${directorySearch(query)}`,
    { signal },
  );
export const listMemberCandidates = (
  id: string,
  query: PageQuery = {},
  signal?: AbortSignal,
) =>
  requestController<
    DirectoryPage<{ id: string; name: string; username: string }>
  >(
    `/api/v1/projects/${encodeURIComponent(id)}/member-candidates${directorySearch(query)}`,
    { signal },
  );
export const setProjectMember = (
  projectId: string,
  userId: string,
  enabled: boolean,
) =>
  requestController<void>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
    { method: enabled ? "PUT" : "DELETE" },
  );

export const getProjectRunner = (id: string, signal?: AbortSignal) =>
  requestController<import("../../shared/project-groups").ProjectRunnerView>(
    `/api/v1/projects/${encodeURIComponent(id)}/runner`, { signal });
export const configureProjectRunner = (id: string, input: import("../../shared/project-groups").ProjectRunnerConfiguration) =>
  requestController<import("../../shared/project-groups").ProjectRunnerView>(
    `/api/v1/projects/${encodeURIComponent(id)}/runner`, json("PUT", input));
