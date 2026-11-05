/** Top-level console and service paths cannot also identify a Project. */
export const reservedProjectPaths = new Set([
  "api", "assets", "docs", "document", "account", "access", "settings", "audit-log",
  "health", "metrics", "dashboard", "guardrails", "policy-library",
  "playground", "integration", "logs", "billing",
]);
