import { Outlet, useRouterState } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { AccountMenu } from "@/components/account-menu";
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
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/lib/auth";
import { LoginPage } from "@/routes/login";

const names: Record<string, { group?: string; page: string }> = {
  "/": { page: "nav.dashboard" },
  "/dashboard": { page: "nav.dashboard" },
  "/guardrails": { group: "nav.guardrailDesign", page: "nav.guardrails" },
  "/policy-library": { group: "nav.guardrailDesign", page: "nav.policyLibrary" },
  "/playground": { group: "nav.guardrailDesign", page: "nav.playground" },
  "/deployments": { group: "nav.runtime", page: "nav.deployments" },
  "/integrations": { group: "nav.runtime", page: "nav.integrations" },
  "/logs": { group: "nav.observability", page: "nav.logs" },
  "/audit-log": { group: "nav.observability", page: "nav.auditLog" },
  "/access": { group: "nav.system", page: "nav.access" },
  "/account": { group: "nav.system", page: "account.title" },
  "/settings": { group: "nav.settings", page: "nav.status" },
  "/settings/status": { group: "nav.settings", page: "nav.status" },
  "/settings/providers": { group: "nav.settings", page: "nav.providers" },
  "/settings/models": { group: "nav.settings", page: "nav.models" },
  "/settings/guardrail-catalog": { group: "nav.settings", page: "nav.guardrailCatalog" },
  "/help": { group: "nav.helpResources", page: "nav.helpCenter" },
};

export function ControlPlaneLayout() {
  const { t } = useTranslation();
  const auth = useAuth();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const location = names[pathname]
    ?? (pathname.startsWith("/guardrails/") ? names["/guardrails"] : undefined)
    ?? (pathname.startsWith("/deployments/") ? names["/deployments"] : undefined)
    ?? { page: "nav.dashboard" };
  if (auth.isLoading) {
    return <div className="flex min-h-dvh items-center justify-center bg-background"><div className="flex items-center gap-3 text-sm text-muted-foreground"><ShieldCheck className="size-5 animate-pulse text-primary" />{t("auth.sessionLoading")}</div></div>;
  }
  if (!auth.status?.authenticated || !auth.user) return <LoginPage />;

  return (
    <TooltipProvider>
      <SidebarProvider style={{ "--sidebar-width": "15.75rem" } as CSSProperties}>
        <ControlPlaneSidebar />
        <SidebarInset className="min-w-0 bg-background">
          <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-card/90 px-4 backdrop-blur-md sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <SidebarTrigger className="size-11 rounded-lg" />
              <Separator orientation="vertical" className="h-5" />
              {location.group ? <Breadcrumb className="min-w-0">
                <BreadcrumbList className="flex-nowrap">
                  <BreadcrumbItem className="hidden sm:inline-flex">{t(location.group)}</BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden sm:block" />
                  <BreadcrumbItem className="min-w-0">
                    <BreadcrumbPage className="truncate">{t(location.page)}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb> : <span className="truncate text-sm font-medium text-foreground">{t(location.page)}</span>}
            </div>
            <AccountMenu placement="header" />
          </header>
          <main className="w-full min-w-0 flex-1 px-4 pb-12 sm:px-6 lg:px-8">
            <Outlet />
          </main>
        </SidebarInset>
        <Toaster richColors />
      </SidebarProvider>
    </TooltipProvider>
  );
}
