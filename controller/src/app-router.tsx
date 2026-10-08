import { runtimeLogOutcomes, type RuntimeLogOutcome } from "../shared/runtime-outcome";
import { auditLogSearch } from "../shared/audit-query";
import { selectedSeverities } from "../shared/security-severity";
import { createBrowserHistory, createRootRoute, createRoute, createRouter, Navigate, notFound, redirect, useRouterState } from "@tanstack/react-router";

import { ControlPlaneLayout } from "@/routes/layout";
import { GuardrailDetailPage, GuardrailsPage } from "@/routes/guardrails";
import { RoutersPage } from "@/routes/routers";
import { RouterDetailPage } from "@/routes/router-detail";
import { LogsPage } from "@/routes/logs";
import { EndpointsPage } from "@/routes/endpoints";
import { PlaygroundPage } from "@/routes/playground";
import { UsersPage } from "@/routes/users";
import { DashboardPage } from "@/routes/dashboard";
import { PolicyLibraryPage } from "@/routes/policy-library";
import { AccountPage } from "@/routes/account";
import { HelpPage, DocumentNotFound } from "@/routes/help";
import { getHelpContent } from "@/features/help-content";
import { documentPath, resolveLegacyDocument } from "@/features/help-navigation";
import { AuditLogPage } from "@/routes/audit-log";
import { VersionPage } from "@/routes/version";
import { HealthPage } from "@/routes/status";
import { RunnerPage } from "@/routes/runner";
import { GuardrailCatalogPage, ModelsPage, ProvidersPage } from "@/routes/models";
import { policyLibrarySearch } from "@/lib/policy-library-search";
import { isGuardrailVersionId } from "../shared/guardrail-version";

const rootRoute = createRootRoute({ component: ControlPlaneLayout });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <Navigate to="/dashboard" replace /> });
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/dashboard", component: DashboardPage });
const guardrailsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/guardrails", component: GuardrailsPage });
const guardrailDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/guardrails/$guardrailId", validateSearch: (search: Record<string, unknown>): { tab?: string; window?: "1h" | "24h" | "7d" | "15d" | "30d"; severity?: string } => ({
  tab: ["runtime", "event", "immutable", "testing", "draft"].includes(String(search.tab)) ? String(search.tab) : undefined,
  window: ["1h", "24h", "7d", "15d", "30d"].includes(String(search.window)) ? search.window as "1h" | "24h" | "7d" | "15d" | "30d" : undefined,
  severity: selectedSeverities(search.severity).join(",") || undefined,
}), component: GuardrailDetailPage });
const policyLibraryRoute = createRoute({ getParentRoute: () => rootRoute, path: "/policy-library", validateSearch: policyLibrarySearch, component: PolicyLibraryPage });
const guardrailSearch = (search: Record<string, unknown>) => ({ guardrail: typeof search.guardrail === "string" ? search.guardrail : undefined });
const playgroundSearch = (search: Record<string, unknown>): { guardrail?: string; target?: "draft"; version?: string; mode?: "advanced"; router?: string; endpoint?: string } => {
  return {
    ...guardrailSearch(search),
    mode: search.mode === "advanced" ? "advanced" as const : undefined,
    router: typeof search.router === "string" ? search.router : undefined,
    endpoint: typeof search.endpoint === "string" ? search.endpoint : undefined,
    target: search.target === "draft" ? "draft" as const : undefined,
    version: isGuardrailVersionId(search.version) ? search.version : undefined,
  };
};
const playgroundRoute = createRoute({ getParentRoute: () => rootRoute, path: "/playground", validateSearch: playgroundSearch, component: PlaygroundPage });
const routersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/integration/routers", component: RoutersPage });
const routerDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/integration/routers/$routerId", validateSearch: (search: Record<string, unknown>): { routeId?: string; tab?: string } => ({ routeId: typeof search.routeId === "string" ? search.routeId : undefined, tab: ['overview', 'endpoints', 'routing', 'monitoring', 'revisions', 'change-requests'].includes(String(search.tab)) ? String(search.tab) : undefined }), component: RouterDetailPage });
const endpointsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/integration/endpoints",
  validateSearch: (search: Record<string, unknown>): { endpointId?: string } => ({
    endpointId: typeof search.endpointId === "string" && search.endpointId.trim() ? search.endpointId : undefined,
  }),
  component: EndpointsRoutePage,
});
function EndpointsRoutePage() {
  const { endpointId } = endpointsRoute.useSearch();
  const navigate = endpointsRoute.useNavigate();
  return <EndpointsPage endpointId={endpointId} onEndpointChange={(id) => {
    // Closing a URL-driven sheet must not add a history entry that Back reopens.
    if (id === endpointId) return;
    void navigate({ search: (previous) => ({ ...previous, endpointId: id }), replace: id === undefined });
  }} />;
}
const logsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/logs", validateSearch: (search: Record<string, unknown>): { requestId?: string; checkpointId?: string; eventId?: string; outcome?: RuntimeLogOutcome; guardrailId?: string; routerId?: string; routeId?: string; targetId?: string; routerRevision?: number; since?: string; until?: string; endpointId?: string } => ({
  ...Object.fromEntries(['requestId', 'checkpointId', 'eventId', 'guardrailId', 'routerId', 'routeId', 'targetId', 'endpointId', 'since', 'until'].flatMap(key => typeof search[key] === 'string' && search[key].trim() ? [[key, search[key]]] : [])),
  ...(runtimeLogOutcomes.includes(search.outcome as RuntimeLogOutcome) ? { outcome: search.outcome as RuntimeLogOutcome } : {}),
  ...(Number.isInteger(Number(search.routerRevision)) && Number(search.routerRevision) > 0 ? { routerRevision: Number(search.routerRevision) } : {}),
}), component: LogsPage });
const auditLogRoute = createRoute({ getParentRoute: () => rootRoute, path: "/audit-log", validateSearch: auditLogSearch, component: AuditLogPage });
const usersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/access", component: UsersPage });
const accountRoute = createRoute({ getParentRoute: () => rootRoute, path: "/account", component: AccountRoutePage });
function AccountRoutePage() {
  const path = useRouterState({ select: state => state.location.pathname.replace(/\/$/, "") });
  return <AccountPage section={path === "/account/security" ? "security" : path === "/account/access-tokens" ? "access-tokens" : "general"} />;
}
const accountSecurityRoute = createRoute({ getParentRoute: () => accountRoute, path: "security", component: () => null });
const accountTokensRoute = createRoute({ getParentRoute: () => accountRoute, path: "access-tokens", component: () => null });
const accountGeneralRoute = createRoute({ getParentRoute: () => accountRoute, path: "general", beforeLoad: () => { throw redirect({ to: "/account", replace: true }); } });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: () => <Navigate to="/settings/health" replace /> });
const versionRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/version", component: VersionPage });
const healthRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/health", component: HealthPage });
const runnerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/runner", component: RunnerPage });
const providersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/providers", component: ProvidersPage });
const modelsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/models", component: ModelsPage });
const guardrailCatalogRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/guardrail-catalog", component: GuardrailCatalogPage });
const documentRoute = createRoute({ getParentRoute: () => rootRoute, path: "/document", notFoundComponent: DocumentNotFound });
const documentIndexRoute = createRoute({
  getParentRoute: () => documentRoute,
  path: "/",
  beforeLoad: ({ location }) => {
    // Article and section IDs are shared by both translations.
    const target = resolveLegacyDocument(getHelpContent("en"), location.hash);
    if (!target) throw notFound();
    throw redirect({ to: documentPath(target.document), hash: target.anchor, replace: true });
  },
});
const documentArticleRoute = createRoute({
  getParentRoute: () => documentRoute,
  path: "$categoryId/$articleId",
  beforeLoad: ({ params }) => {
    if (!getHelpContent("en").documents.some(document => document.categoryId === params.categoryId && document.id === params.articleId)) throw notFound();
  },
  component: HelpPage,
});
function LegacyHelpRedirect() {
  const hash = useRouterState({ select: state => state.location.hash });
  return <Navigate to="/document" hash={hash} replace />;
}
const helpRoute = createRoute({ getParentRoute: () => rootRoute, path: "/help", component: LegacyHelpRedirect });
export const routeTree = rootRoute.addChildren([
  indexRoute,
  dashboardRoute,
  guardrailsRoute,
  guardrailDetailRoute,
  policyLibraryRoute,
  playgroundRoute,
  routersRoute,
  routerDetailRoute,
  endpointsRoute,
  logsRoute,
  auditLogRoute,
  usersRoute,
  accountRoute.addChildren([accountSecurityRoute, accountTokensRoute, accountGeneralRoute]),
  settingsRoute,
  healthRoute,
  versionRoute,
  runnerRoute,
  providersRoute,
  modelsRoute,
  guardrailCatalogRoute,
  documentRoute.addChildren([documentIndexRoute, documentArticleRoute]),
  helpRoute,
]);
export const router = createRouter({ routeTree, history: createBrowserHistory() });
declare module "@tanstack/react-router" { interface Register { router: typeof router } }
