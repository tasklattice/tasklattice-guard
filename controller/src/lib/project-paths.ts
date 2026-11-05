import { currentProjectId } from "./project-context";
import { reservedProjectPaths } from "../../shared/console-paths";

const projectRoots = ["/", "/guardrails", "/policy-library", "/playground", "/integration/routers", "/integration/endpoints", "/logs", "/billing"];
const projectSettings = ["/settings", "/settings/runner", "/settings/health", "/settings/version"];

/** Resource paths used to identify project pages in the shell. */
export function isProjectPage(pathname: string) {
  const path = pathname.replace(/\/$/, "") || "/";
  return projectRoots.some(root => path === root || path.startsWith(`${root}/`)) || projectSettings.includes(path);
}

export function projectLocation(pathname: string): { projectId: string; pathname: string } | null {
  const [, segment, ...rest] = pathname.split("/");
  if (!segment) return null;
  let projectId: string;
  try { projectId = decodeURIComponent(segment); } catch { return null; }
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(projectId) || reservedProjectPaths.has(projectId)) return null;
  const path = `/${rest.join("/")}`;
  // Unknown children still go through the Project boundary, then the router's 404.
  return { projectId, pathname: path };
}

export function projectPath(projectId: string | null | undefined, pathname = "/") {
  if (!projectId) return pathname;
  const path = pathname.replace(/\/$/, "") || "/";
  return `/${encodeURIComponent(projectId)}${path === "/" ? "" : path}`;
}

export function projectRoutePath(pathname: string) {
  const scoped = projectLocation(pathname);
  return scoped ? `/$projectId${scoped.pathname === "/" ? "" : scoped.pathname.replace(/\/$/, "")}` : pathname;
}

/** Prefer the address being opened over the session's previously selected Project. */
export function navigationProjectId() {
  return projectLocation(window.location.pathname)?.projectId ?? currentProjectId();
}

export const projectParams = () => ({ projectId: navigationProjectId() ?? "" });
