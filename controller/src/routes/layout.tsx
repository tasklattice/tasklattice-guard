import { Link, Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { pagePermission, hasPermission, isPlatformAdministrator, roleHome } from "../../shared/rbac";
import { EmptyState } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { useQuery } from '@tanstack/react-query';
import { getTrafficRouter, trafficRouterKeys } from '@/lib/traffic-routing-api';
import { ShieldCheck } from "lucide-react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { AccountMenu } from "@/components/account-menu";
import { ProjectInitializationGate } from "@/components/project-initialization";
import { ProjectRouteSelection } from "@/components/project-route-selection";
import { isProjectPage, projectLocation, projectParams } from "@/lib/project-paths";
import { ControlPlaneSidebar } from "@/components/control-plane-sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/notifications";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/lib/auth";
import { LoginPage } from "@/routes/login";
import { HelpLayout } from "@/routes/help-layout";

const names: Record<string, { group?: string; page: string }> = {
  "/": { page: "nav.dashboard" },
  "/guardrails": { group: "nav.guardrailDesign", page: "nav.guardrails" },
  "/policy-library": { group: "nav.guardrailDesign", page: "nav.policyLibrary" },
  "/playground": { group: "nav.guardrailDesign", page: "nav.playground" },
  "/integration/routers": { group: "nav.runtime", page: "nav.routers" },
  "/integration/endpoints": { group: "nav.runtime", page: "nav.endpoints" },
  "/billing": { group: "nav.runtimeObservations", page: "nav.billing" },
  "/logs": { group: "nav.runtimeObservations", page: "nav.logs" },
  "/audit-log": { group: "nav.platformOperations", page: "nav.auditLog" },
  "/access": { group: "nav.peopleProjects", page: "nav.access" },
  "/access/projects": { group: "nav.peopleProjects", page: "projects.title" },
  "/account": { page: "account.title" },
  "/settings": { group: "nav.platformOperations", page: "nav.health" },
  "/settings/version": { group: "nav.platformOperations", page: "nav.version" },
  "/settings/health": { group: "nav.platformOperations", page: "nav.health" },
  "/settings/runner": { group: "nav.platformOperations", page: "nav.runner" },
  "/settings/providers": { group: "nav.modelServices", page: "nav.providers" },
  "/settings/models": { group: "nav.modelServices", page: "nav.models" },
  "/settings/protection-capabilities": { group: "nav.modelServices", page: "nav.guardrailCatalog" },
  "/document": { group: "nav.helpResources", page: "nav.helpCenter" },
};

export function ControlPlaneLayout() {
  const { t } = useTranslation();
  const auth = useAuth();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const scoped = projectLocation(path);
  const pathname = scoped?.pathname ?? path;
  // Documentation is public, including while the session is loading or unavailable.
  if (!scoped && (pathname === "/document" || pathname.startsWith("/document/"))) return <HelpLayout />;
  const location = names[pathname]
    ?? (pathname.startsWith("/account/") ? names["/account"] : undefined)
    ?? (pathname.startsWith("/guardrails/") ? names["/guardrails"] : undefined)
    ?? (pathname.startsWith("/integration/routers/") ? names["/integration/routers"] : undefined)
    ?? { page: "nav.dashboard" };
  if (auth.isLoading) {
    return <div className="flex min-h-dvh items-center justify-center bg-background"><div className="flex items-center gap-3 text-sm text-muted-foreground"><ShieldCheck className="size-5 animate-pulse text-primary" />{t("auth.sessionLoading")}</div></div>;
  }
  if (!auth.status?.authenticated || !auth.user) return <LoginPage />;
  if (auth.user.role === "user") {
    if (scoped && scoped.projectId !== auth.user.project_id) return <ProjectRouteSelection key={scoped.projectId} projectId={scoped.projectId} />;
  }
  const home = roleHome(auth.user.role);
  if (path === "/" && auth.user.role === "admin") return <Navigate to={home} replace />;
  if (path === "/" && auth.user.project_id) return <Navigate to="/$projectId" params={{ projectId: auth.user.project_id }} replace />;
  const permission = pagePermission(pathname);
  const forbidden = Boolean(scoped && (!isProjectPage(pathname) || auth.user.role !== "user"))
    || Boolean(!scoped && path !== "/" && auth.user.role === "user" && isProjectPage(pathname))
    || (permission !== null && !hasPermission(auth.user.role, permission.resource, permission.action));
  const group = location.group === "nav.platformOperations" && pathname.startsWith("/settings") && !isPlatformAdministrator(auth.user.role)
    ? "nav.settings" : location.group;

  return (
    <TooltipProvider>
      <SidebarProvider key={`${auth.user.id}:${auth.user.role}:${auth.user.project_id ?? "platform"}`} style={{ "--sidebar-width": "15.75rem" } as CSSProperties}>
        <ControlPlaneSidebar />
        <SidebarInset className="min-w-0 bg-background">
          <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-card px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <SidebarTrigger className="size-11 rounded-lg" />
              <Separator orientation="vertical" className="h-5 self-center" />
              {group ? <Breadcrumb className="min-w-0">
                <BreadcrumbList className="flex-nowrap">
                  <BreadcrumbItem className="hidden sm:inline-flex">{t(group)}</BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden sm:block" />
                  <BreadcrumbItem className="min-w-0">
                    {pathname.startsWith('/integration/routers/') ? <Link to="/$projectId/integration/routers" params={projectParams()} className="truncate">{t(location.page)}</Link> : pathname.startsWith("/account/") ? <Link to="/account" className="truncate">{t(location.page)}</Link> : <BreadcrumbPage className="truncate">{t(location.page)}</BreadcrumbPage>}
                  </BreadcrumbItem>
                  {pathname.startsWith('/account/') && <><BreadcrumbSeparator /><BreadcrumbItem><BreadcrumbPage>{pathname === '/account/security' ? t('account.security') : 'Access Tokens'}</BreadcrumbPage></BreadcrumbItem></>}
                  {pathname.startsWith('/integration/routers/') && <RouterNameBreadcrumb id={decodeURIComponent(pathname.split('/').at(-1)!)} />}
                </BreadcrumbList>
              </Breadcrumb> : <span className="truncate text-sm font-medium text-foreground">{t(location.page)}</span>}
            </div>
            <AccountMenu placement="header" />
          </header>
          <main className="w-full min-w-0 flex-1 px-4 pb-12 sm:px-6 lg:px-8">
            {forbidden ? <section className="py-8"><EmptyState
              title={t("auth.accessDeniedTitle")}
              description={t("auth.rolePageDenied")}
              action={<Button asChild><Link to={home}>{t(auth.user.role === "user" ? "nav.dashboard" : "nav.platform")}</Link></Button>}
            /></section> : auth.user.role === "user" && !pathname.startsWith("/account") ? <ProjectInitializationGate><Outlet /></ProjectInitializationGate> : <Outlet />}
          </main>
        </SidebarInset>
        <Toaster />
      </SidebarProvider>
    </TooltipProvider>
  );
}

function RouterNameBreadcrumb({id}:{id:string}) {
  const query=useQuery({queryKey:trafficRouterKeys.detail(id),queryFn:()=>getTrafficRouter(id)});
  return <><BreadcrumbSeparator/><BreadcrumbItem className="min-w-0"><BreadcrumbPage className="truncate">{query.data?.name ?? 'Router'}</BreadcrumbPage></BreadcrumbItem></>;
}
