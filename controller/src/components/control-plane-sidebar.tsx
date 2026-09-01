import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, Cable, ChevronUp, CircleHelp, FlaskConical, History, LayoutDashboard, LibraryBig, ListChecks, Rocket, ScrollText, Server, Settings, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { listControllerDeployments, listControllerGuardrails, listControllerIntegrations } from "@/lib/controller-api";

const navigation = [
  {
    label: "nav.home",
    items: [
      { label: "nav.dashboard", to: "/dashboard", icon: LayoutDashboard },
      { label: "nav.playground", to: "/playground", icon: FlaskConical },
    ],
  },
  {
    label: "nav.buildValidate",
    items: [
      { label: "nav.guardrails", to: "/guardrails", icon: ShieldCheck, count: "guardrails" },
      { label: "nav.policyLibrary", to: "/policy-library", icon: LibraryBig },
      { label: "nav.validation", to: "/validation", icon: ListChecks },
    ],
  },
  {
    label: "nav.runtime",
    items: [
      { label: "nav.deployments", to: "/deployments", icon: Rocket, count: "deployments" },
      { label: "nav.integrations", to: "/integrations", icon: Cable, count: "integrations" },
      { label: "nav.runners", to: "/runners", icon: Server },
    ],
  },
  {
    label: "nav.assurance",
    items: [
      { label: "nav.evidence", to: "/evidence", icon: Activity },
      { label: "nav.logs", to: "/logs", icon: ScrollText },
      { label: "nav.activity", to: "/activity", icon: History },
    ],
  },
] as const;

export function ControlPlaneSidebar() {
  const { t } = useTranslation();
  const { isMobile, setOpen, setOpenMobile, state } = useSidebar();
  const pathname = useRouterState({ select: (routerState) => routerState.location.pathname });
  const settingsActive = pathname.startsWith("/settings/");
  const [settingsOpen, setSettingsOpen] = useState(settingsActive);
  useEffect(() => {
    if (settingsActive) setSettingsOpen(true);
  }, [settingsActive]);
  const guardrails = useQuery({ queryKey: ["controller", "guardrails"], queryFn: listControllerGuardrails });
  const deployments = useQuery({ queryKey: ["controller", "deployments"], queryFn: listControllerDeployments });
  const integrations = useQuery({ queryKey: ["controller", "integrations"], queryFn: listControllerIntegrations });
  const counts: Record<string, number | undefined> = {
    guardrails: guardrails.data?.items.length,
    deployments: deployments.data?.items.length,
    integrations: integrations.data?.items.length,
  };
  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className="h-16 justify-center border-b border-sidebar-border px-4 group-data-[collapsible=icon]:px-3">
        <Link
          to="/dashboard"
          aria-label="TaskLattice Guard"
          onClick={() => setOpenMobile(false)}
          className="flex min-h-11 items-center gap-2.5 rounded-lg px-1 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:justify-center"
        >
          <ShieldCheck className="size-5 shrink-0 text-primary" strokeWidth={2.2} />
          <span className="min-w-0 text-sm font-semibold tracking-[-0.02em] text-foreground group-data-[collapsible=icon]:hidden">
            TaskLattice <span className="font-medium text-muted-foreground">Guard</span>
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent className="px-2 py-3">
        {navigation.map((group) => {
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
                          className="h-11 rounded-lg px-2.5 text-[13px] text-sidebar-foreground/80 data-active:bg-accent data-active:font-medium data-active:text-accent-foreground group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-11! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!"
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
        <SidebarGroup className="mt-auto px-0 pt-3 pb-0 group-data-[collapsible=icon]:px-1">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname === "/help"}
                  tooltip={t("nav.helpCenter")}
                  className="h-11 rounded-lg px-2.5 text-[13px] text-sidebar-foreground/80 data-active:bg-accent data-active:font-medium data-active:text-accent-foreground group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-11! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!"
                >
                  <Link
                    to="/help"
                    aria-label={state === "collapsed" ? t("nav.helpCenter") : undefined}
                    onClick={() => setOpenMobile(false)}
                  >
                    <CircleHelp className="size-4.5" strokeWidth={pathname === "/help" ? 2.2 : 1.8} />
                    <span className="group-data-[collapsible=icon]:hidden">{t("nav.helpCenter")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-1.5 border-t border-sidebar-border p-2.5">
        <SidebarMenu>
          <SidebarMenuItem className="flex flex-col">
            <SidebarMenuButton
              type="button"
              tooltip={t("nav.settings")}
              aria-expanded={settingsOpen}
              aria-controls="settings-navigation"
              className="h-11 rounded-lg px-2.5 text-[13px] text-sidebar-foreground/80 focus-visible:ring-1 focus-visible:ring-inset hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-11! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!"
              onClick={() => {
                if (!isMobile && state === "collapsed") {
                  setOpen(true);
                  setSettingsOpen(true);
                  return;
                }
                setSettingsOpen((open) => !open);
              }}
            >
              <Settings className="size-4.5" strokeWidth={settingsActive ? 2.2 : 1.8} />
              <span className="group-data-[collapsible=icon]:hidden">{t("nav.settings")}</span>
              <ChevronUp className={`ml-auto size-4 transition-transform group-data-[collapsible=icon]:hidden ${settingsOpen ? "rotate-180" : ""}`} />
            </SidebarMenuButton>
            {settingsOpen ? (
              <SidebarMenuSub id="settings-navigation" className="order-first mb-1 pt-0 pb-1">
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton
                    asChild
                    isActive={pathname === "/settings/status"}
                    className="h-11 text-[13px] focus-visible:ring-1 focus-visible:ring-inset"
                  >
                    <Link to="/settings/status" onClick={() => setOpenMobile(false)}>
                      <Activity />
                      <span>{t("nav.status")}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              </SidebarMenuSub>
            ) : null}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
