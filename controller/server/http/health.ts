export function readinessBody(ready: boolean, reason: string, message: string | null = null, detail: Record<string, unknown> = {}) {
  return {
    ...detail,
    component: "guard-controller",
    status: ready ? "ready" : "not_ready",
    ready,
    reason,
    error: ready ? null : { code: reason, message: message ?? "Controller is not ready." },
  };
}

export function isOperationalPath(path: string): boolean {
  return path === "/healthz" || path.startsWith("/healthz/")
    || path === "/health" || path.startsWith("/health/")
    || path === "/version" || path.startsWith("/version/");
}
