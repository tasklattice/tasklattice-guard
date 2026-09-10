import { createBrowserHistory, createRootRoute, createRoute, createRouter, Navigate } from "@tanstack/react-router";

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
import { HelpPage } from "@/routes/help";
import { AuditLogPage } from "@/routes/audit-log";
import { HealthPage } from "@/routes/status";
import { RunnerPage } from "@/routes/runner";
import { GuardrailCatalogPage, ModelsPage, ProvidersPage } from "@/routes/models";
import { policyLibrarySearch } from "@/lib/policy-library-search";
import { isGuardrailVersionId } from "../shared/guardrail-version";

const rootRoute = createRootRoute({ component: ControlPlaneLayout });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <Navigate to="/dashboard" replace /> });
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/dashboard", component: DashboardPage });
const guardrailsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/guardrails", component: GuardrailsPage });
const guardrailDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/guardrails/$guardrailId", component: GuardrailDetailPage });
const policyLibraryRoute = createRoute({ getParentRoute: () => rootRoute, path: "/policy-library", validateSearch: policyLibrarySearch, component: PolicyLibraryPage });
const guardrailSearch = (search: Record<string, unknown>) => ({ guardrail: typeof search.guardrail === "string" ? search.guardrail : undefined });
const playgroundSearch = (search: Record<string, unknown>) => {
  return {
    ...guardrailSearch(search),
    target: search.target === "draft" ? "draft" as const : undefined,
    version: isGuardrailVersionId(search.version) ? search.version : undefined,
  };
};
const playgroundRoute = createRoute({ getParentRoute: () => rootRoute, path: "/playground", validateSearch: playgroundSearch, component: PlaygroundPage });
const routersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/integration/routers", component: RoutersPage });
const routerDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/integration/routers/$routerId", component: RouterDetailPage });
const endpointRoute = createRoute({ getParentRoute: () => rootRoute, path: "/integration/endpoint", component: EndpointsPage });
const logsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/logs", component: LogsPage });
const auditLogRoute = createRoute({ getParentRoute: () => rootRoute, path: "/audit-log", component: AuditLogPage });
const usersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/access", component: UsersPage });
const accountRoute = createRoute({ getParentRoute: () => rootRoute, path: "/account", component: AccountPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: () => <Navigate to="/settings/health" replace /> });
const healthRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/health", component: HealthPage });
const runnerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/runner", component: RunnerPage });
const providersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/providers", component: ProvidersPage });
const modelsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/models", component: ModelsPage });
const guardrailCatalogRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/guardrail-catalog", component: GuardrailCatalogPage });
const helpRoute = createRoute({ getParentRoute: () => rootRoute, path: "/help", component: HelpPage });
export const routeTree = rootRoute.addChildren([
  indexRoute,
  dashboardRoute,
  guardrailsRoute,
  guardrailDetailRoute,
  policyLibraryRoute,
  playgroundRoute,
  routersRoute,
  routerDetailRoute,
  endpointRoute,
  logsRoute,
  auditLogRoute,
  usersRoute,
  accountRoute,
  settingsRoute,
  healthRoute,
  runnerRoute,
  providersRoute,
  modelsRoute,
  guardrailCatalogRoute,
  helpRoute,
]);
export const router = createRouter({ routeTree, history: createBrowserHistory() });
declare module "@tanstack/react-router" { interface Register { router: typeof router } }

