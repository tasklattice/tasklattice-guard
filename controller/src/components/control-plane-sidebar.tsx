import { projectParams, projectRoutePath } from "@/lib/project-paths";
import { hasPermission, isPlatformAdministrator, roleHome } from "../../shared/rbac";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, Bot, Building2, Cable, CircleHelp, FlaskConical, GitBranch, History, LibraryBig, ReceiptText, Rocket, ScrollText, Server, ServerCog, Settings, ShieldCheck, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";

import { BrandLogo } from "@/components/brand-logo";
import { ProjectSwitcher } from "@/components/project-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { listGuardrailOptions, listControllerEndpoints } from "@/lib/controller-api";
import { queryKeys } from "@/features/query-keys";
import { listTrafficRouters, trafficRouterKeys } from "@/lib/traffic-routing-api";
import { useAuth } from "@/lib/auth";

const navigation = [
  {
    scope: "project",
    label: "nav.guardrailDesign",
    items: [
      { label: "nav.guardrails", to: "/$projectId/guardrails", icon: ShieldCheck, count: "guardrails" },
      { label: "nav.playground", to: "/$projectId/playground", icon: FlaskConical },
      // Shows the released Policies where Guardrails are not authored.
      { label: "nav.policyLibrary", to: "/$projectId/policy-library", icon: LibraryBig },
    ],
  },
  {
    scope: "project",
    label: "nav.runtime",
    items: [
      { label: "nav.routers", to: "/$projectId/integration/routers", icon: Rocket, count: "routers" },
      { label: "nav.endpoints", to: "/$projectId/integration/endpoints", icon: Cable, count: "endpoints" },
    ],
  },
  {
    scope: "project",
    label: "nav.runtimeObservations",
    items: [
      { label: "nav.logs", to: "/$projectId/logs", icon: ScrollText },
      { label: "nav.billing", to: "/$projectId/billing", icon: ReceiptText },
    ],
  },
  {
    scope: "platform",
    label: "nav.peopleProjects",
    items: [
      { label: "nav.access", to: "/access", icon: UsersRound },
      { label: "projects.title", to: "/access/projects", icon: Building2 },
    ],
  },
  {
    scope: "platform",
    label: "nav.modelServices",
    items: [
      { label: "nav.providers", to: "/settings/providers", icon: ServerCog },
      { label: "nav.models", to: "/settings/models", icon: Bot },
      { label: "nav.guardrailCatalog", to: "/settings/protection-capabilities", icon: LibraryBig },
    ],
  },
  {
    scope: "platform",
    label: "nav.platformOperations",
    items: [
      { label: "nav.runner", to: "/settings/runner", icon: Server },
      { label: "nav.health", to: "/settings/health", icon: Activity },
      { label: "nav.auditLog", to: "/audit-log", icon: History },
      { label: "nav.version", to: "/settings/version", icon: GitBranch },
    ],
  },
] as const;

export function ControlPlaneSidebar() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const administrator = isPlatformAdministrator(user?.role);
  const workflowUser = hasPermission(user?.role, "guardrails", "write") && Boolean(user?.project_id);
  const { setOpenMobile, state } = useSidebar();
  const pathname = useRouterState({ select: (routerState) => projectRoutePath(routerState.location.pathname) });
  const guardrails = useQuery({ queryKey: [...queryKeys.guardrails, "options", "project", user?.project_id], queryFn: ({ signal }) => listGuardrailOptions(signal), enabled: workflowUser });
  const routers = useQuery({ queryKey: [...trafficRouterKeys.all, "project", user?.project_id], queryFn: listTrafficRouters, enabled: workflowUser });
  const endpoints = useQuery({ queryKey: [...queryKeys.endpoints, "definitions", "project", user?.project_id], queryFn: listControllerEndpoints, enabled: workflowUser });
  const counts: Record<string, number | undefined> = {
    guardrails: guardrails.data?.items.length,
    routers: routers.data?.items.length,
    endpoints: endpoints.data?.items.length,
  };
  return (
      <Sidebar collapsible="icon" className="border-r border-sidebar-border">
        <SidebarHeader className="h-16 justify-center border-b border-sidebar-border px-4 group-data-[collapsible=icon]:px-3">
          <Link params={projectParams()}
            to={user?.project_id && hasPermission(user?.role, "runtime") ? "/$projectId" : roleHome(user?.role)}
            aria-label="TaskLattice Guard"
            onClick={() => setOpenMobile(false)}
            className="flex min-h-11 items-center gap-2.5 rounded-lg px-1 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:justify-center"
          >
            <BrandLogo wordmarkClassName="group-data-[collapsible=icon]:hidden" />
          </Link>
        </SidebarHeader>

        <SidebarContent className="px-2 py-3">
          {!administrator ? <div className="mx-1 mb-2"><ProjectSwitcher collapsed={state === "collapsed"} /></div> : null}
          {navigation.filter(group => group.scope === "platform" ? administrator : workflowUser).map((group) => {
            return (
              <SidebarGroup key={group.label} className="px-0 py-2 group-data-[collapsible=icon]:px-1">
                {group.label ? <SidebarGroupLabel className="h-7 px-2.5 text-xs font-medium text-sidebar-foreground/75 group-data-[collapsible=icon]:hidden">
                  {t(group.label)}
                </SidebarGroupLabel> : null}
                <SidebarGroupContent>
                  <SidebarMenu className="gap-1">
                    {group.items.map((item) => {
                      const active = pathname === item.to || (item.to !== "/access" && pathname.startsWith(`${item.to}/`));
                      const count = "count" in item ? counts[item.count] : undefined;
                      const label = t(item.label);
                      return (
                        <SidebarMenuItem key={item.to}>
                          <SidebarMenuButton
                            asChild
                            isActive={active}
                            tooltip={label}
                            className="h-11 rounded-lg px-2.5 text-[13px] text-sidebar-foreground/80 data-[active=true]:bg-accent data-[active=true]:font-medium data-[active=true]:text-accent-foreground group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-11! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!"
                          >
                            <Link params={projectParams()}
                              to={item.to}
                              aria-label={state === "collapsed" ? label : undefined}
                              onClick={() => setOpenMobile(false)}
                            >
                              <item.icon className="size-4.5" strokeWidth={active ? 2.2 : 1.8} />
                              <span className="group-data-[collapsible=icon]:hidden">{label}</span>
                            </Link>
                          </SidebarMenuButton>
                          {count !== undefined ? <SidebarMenuBadge className="right-2 text-[11px] font-medium text-sidebar-foreground/45">{count}</SidebarMenuBadge> : null}
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            );
          })}
        </SidebarContent>

        <SidebarFooter className="border-t border-sidebar-border p-2.5">
          <SidebarMenu className="gap-1">
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname === "/document"}
                tooltip={t("nav.helpCenter")}
                className="h-11 rounded-lg px-2.5 text-[13px] text-sidebar-foreground/80 data-[active=true]:bg-accent data-[active=true]:font-medium data-[active=true]:text-accent-foreground group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-11! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!"
              >
                <Link
                  to="/document"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={state === "collapsed" ? t("nav.helpCenter") : undefined}
                  onClick={() => setOpenMobile(false)}
                >
                  <CircleHelp className="size-4.5" strokeWidth={pathname === "/document" ? 2.2 : 1.8} />
                  <span className="group-data-[collapsible=icon]:hidden">{t("nav.helpCenter")}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {workflowUser && <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={pathname.startsWith("/$projectId/settings")} tooltip={t("nav.settings")}
                className="h-11 rounded-lg px-2.5 text-[13px] text-sidebar-foreground/80 data-[active=true]:bg-accent data-[active=true]:font-medium data-[active=true]:text-accent-foreground group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-11! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!">
                <Link to="/$projectId/settings/health" params={projectParams()} aria-label={state === "collapsed" ? t("nav.settings") : undefined} onClick={() => setOpenMobile(false)}>
                  <Settings className="size-4.5" strokeWidth={pathname.startsWith("/settings") ? 2.2 : 1.8} />
                  <span className="group-data-[collapsible=icon]:hidden">{t("nav.settings")}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>}
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
  );
}
