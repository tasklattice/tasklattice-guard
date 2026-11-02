import { hasPermission, isPlatformAdministrator, roleHome } from "../../shared/rbac";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, Bot, Cable, CircleHelp, FlaskConical, GitBranch, History, LibraryBig, ReceiptText, Rocket, ScrollText, Server, ServerCog, Settings, ShieldCheck, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";

import { BrandLogo } from "@/components/brand-logo";
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
import { getGuardrails, getEndpoints } from "@/lib/api";
import { queryKeys } from "@/features/query-keys";
import { listTrafficRouters, trafficRouterKeys } from "@/lib/traffic-routing-api";
import { useAuth } from "@/lib/auth";

const navigation = [
  {
    scope: "tenant",
    label: "nav.guardrailDesign",
    items: [
      { label: "nav.guardrails", to: "/guardrails", icon: ShieldCheck, count: "guardrails" },
      { label: "nav.playground", to: "/playground", icon: FlaskConical },
      // Shows the released Policies where Guardrails are not authored.
      { label: "nav.policyLibrary", to: "/policy-library", icon: LibraryBig },
    ],
  },
  {
    scope: "tenant",
    label: "nav.runtime",
    items: [
      { label: "nav.routers", to: "/integration/routers", icon: Rocket, count: "routers" },
      { label: "nav.endpoints", to: "/integration/endpoints", icon: Cable, count: "endpoints" },
    ],
  },
  {
    scope: "tenant",
    label: "nav.runtimeObservations",
    items: [
      { label: "nav.logs", to: "/logs", icon: ScrollText },
      { label: "nav.billing", to: "/billing", icon: ReceiptText },
    ],
  },
  {
    scope: "platform",
    label: "nav.modelServices",
    items: [
      { label: "nav.providers", to: "/settings/providers", icon: ServerCog },
      { label: "nav.models", to: "/settings/models", icon: Bot },
      { label: "nav.guardrailCatalog", to: "/settings/guardrail-catalog", icon: LibraryBig },
    ],
  },
  {
    scope: "platform",
    label: "nav.platformOperations",
    items: [
      { label: "nav.health", to: "/settings/health", icon: Activity },
      { label: "nav.runner", to: "/settings/runner", icon: Server },
      { label: "nav.version", to: "/settings/version", icon: GitBranch },
    ],
  },
  {
    scope: "platform",
    label: "nav.accessAudit",
    items: [
      { label: "nav.access", to: "/access", icon: UsersRound },
      { label: "nav.auditLog", to: "/audit-log", icon: History },
    ],
  },
] as const;

export function ControlPlaneSidebar() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const administrator = isPlatformAdministrator(user?.role);
  const workflowUser = hasPermission(user?.role, "guardrails", "write");
  const { setOpenMobile, state } = useSidebar();
  const pathname = useRouterState({ select: (routerState) => routerState.location.pathname });
  const guardrails = useQuery({ queryKey: queryKeys.guardrails, queryFn: getGuardrails, enabled: workflowUser });
  const routers = useQuery({ queryKey: trafficRouterKeys.all, queryFn: listTrafficRouters, enabled: workflowUser });
  const endpoints = useQuery({ queryKey: queryKeys.endpoints, queryFn: getEndpoints, enabled: workflowUser });
  const counts: Record<string, number | undefined> = {
    guardrails: guardrails.data?.items.length,
    routers: routers.data?.items.length,
    endpoints: endpoints.data?.items.length,
  };
  return (
      <Sidebar collapsible="icon" className="border-r border-sidebar-border">
        <SidebarHeader className="h-16 justify-center border-b border-sidebar-border px-4 group-data-[collapsible=icon]:px-3">
          <Link
            to={hasPermission(user?.role, "runtime") ? "/dashboard" : roleHome(user?.role)}
            aria-label="TaskLattice Guard"
            onClick={() => setOpenMobile(false)}
            className="flex min-h-11 items-center gap-2.5 rounded-lg px-1 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:justify-center"
          >
            <BrandLogo wordmarkClassName="group-data-[collapsible=icon]:hidden" />
          </Link>
        </SidebarHeader>

        <SidebarContent className="px-2 py-3">
          {navigation.filter(group => group.scope === "platform" ? administrator : workflowUser).map((group) => {
            return (
              <SidebarGroup key={group.label} className="px-0 py-2 group-data-[collapsible=icon]:px-1">
                {group.label ? <SidebarGroupLabel className="h-7 px-2.5 text-[11px] font-medium text-sidebar-foreground/55 group-data-[collapsible=icon]:hidden">
                  {t(group.label)}
                </SidebarGroupLabel> : null}
                <SidebarGroupContent>
                  <SidebarMenu className="gap-1">
                    {group.items.map((item) => {
                      const active = pathname === item.to || pathname.startsWith(`${item.to}/`);
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
                            <Link
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
              <SidebarMenuButton asChild isActive={pathname.startsWith("/settings")} tooltip={t("nav.settings")}
                className="h-11 rounded-lg px-2.5 text-[13px] text-sidebar-foreground/80 data-[active=true]:bg-accent data-[active=true]:font-medium data-[active=true]:text-accent-foreground group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-11! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!">
                <Link to="/settings/health" aria-label={state === "collapsed" ? t("nav.settings") : undefined} onClick={() => setOpenMobile(false)}>
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
