import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserHistory, createRootRoute, createRoute, createRouter, Navigate, RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";

import { ControlPlaneLayout } from "@/routes/layout";
import { GuardrailDetailPage, GuardrailsPage } from "@/routes/guardrails";
import { DeploymentsPage } from "@/routes/deployments";
import { DeploymentDetailPage } from "@/routes/deployment-detail";
import { EvidencePage } from "@/routes/evidence";
import { LogsPage } from "@/routes/logs";
import { IntegrationsPage } from "@/routes/integrations";
import { ValidationPage } from "@/routes/validation";
import { PlaygroundPage } from "@/routes/playground";
import { UsersPage } from "@/routes/users";
import { DashboardPage } from "@/routes/dashboard";
import { PolicyLibraryPage } from "@/routes/policy-library";
import { AccountPage } from "@/routes/account";
import { HelpPage } from "@/routes/help";
import { RunnersPage } from "@/routes/runners";
import { ActivityPage } from "@/routes/activity";
import { StatusPage } from "@/routes/status";
import { CapabilitiesPage, ModelsPage, ProvidersPage } from "@/routes/models";
import { AuthProvider } from "@/lib/auth";
import { isGuardrailVersionId } from "../shared/guardrail-version";
import "@/i18n";
import "@/styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1 } } });
const rootRoute = createRootRoute({ component: ControlPlaneLayout });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <Navigate to="/dashboard" replace /> });
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/dashboard", component: DashboardPage });
const guardrailsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/guardrails", component: GuardrailsPage });
const guardrailDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/guardrails/$guardrailId", component: GuardrailDetailPage });
const policyLibrarySearch = (search: Record<string, unknown>) => ({ policy: typeof search.policy === "string" ? search.policy : undefined });
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
const validationRoute = createRoute({ getParentRoute: () => rootRoute, path: "/validation", validateSearch: guardrailSearch, component: ValidationPage });
const deploymentsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/deployments", component: DeploymentsPage });
const deploymentDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/deployments/$deploymentId", component: DeploymentDetailPage });
const integrationsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/integrations", component: IntegrationsPage });
const runnersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/runners", component: RunnersPage });
const evidenceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/evidence", component: EvidencePage });
const logsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/logs", component: LogsPage });
const activityRoute = createRoute({ getParentRoute: () => rootRoute, path: "/activity", component: ActivityPage });
const usersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/access", component: UsersPage });
const accountRoute = createRoute({ getParentRoute: () => rootRoute, path: "/account", component: AccountPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: () => <Navigate to="/settings/status" replace /> });
const statusRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/status", component: StatusPage });
const providersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/providers", component: ProvidersPage });
const modelsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/models", component: ModelsPage });
const capabilitiesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/capabilities", component: CapabilitiesPage });
const helpRoute = createRoute({ getParentRoute: () => rootRoute, path: "/help", component: HelpPage });
const routeTree = rootRoute.addChildren([
  indexRoute,
  dashboardRoute,
  guardrailsRoute,
  guardrailDetailRoute,
  policyLibraryRoute,
  playgroundRoute,
  validationRoute,
  deploymentsRoute,
  deploymentDetailRoute,
  integrationsRoute,
  runnersRoute,
  evidenceRoute,
  logsRoute,
  activityRoute,
  usersRoute,
  accountRoute,
  settingsRoute,
  statusRoute,
  providersRoute,
  modelsRoute,
  capabilitiesRoute,
  helpRoute,
]);
const router = createRouter({ routeTree, history: createBrowserHistory() });
declare module "@tanstack/react-router" { interface Register { router: typeof router } }

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><ThemeProvider attribute="class" defaultTheme="light" forcedTheme="light"><QueryClientProvider client={queryClient}><AuthProvider><RouterProvider router={router} /></AuthProvider></QueryClientProvider></ThemeProvider></React.StrictMode>);
