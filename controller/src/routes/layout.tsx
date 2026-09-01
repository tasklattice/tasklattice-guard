import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Activity, Bot, CircleAlert, Gauge, Server, ShieldCheck } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { ControlPlaneSidebar } from "@/components/control-plane-sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/lib/auth";
import { LoginPage } from "@/routes/login";
import { getControllerSystemStatus } from "@/lib/controller-api";

const names: Record<string, { group: string; page: string }> = {
  "/": { group: "nav.home", page: "nav.dashboard" },
  "/dashboard": { group: "nav.home", page: "nav.dashboard" },
  "/guardrails": { group: "nav.buildValidate", page: "nav.guardrails" },
  "/policy-library": { group: "nav.buildValidate", page: "nav.policyLibrary" },
  "/playground": { group: "nav.home", page: "nav.playground" },
  "/validation": { group: "nav.buildValidate", page: "nav.validation" },
  "/deployments": { group: "nav.runtime", page: "nav.deployments" },
  "/integrations": { group: "nav.runtime", page: "nav.integrations" },
  "/runners": { group: "nav.runtime", page: "nav.runners" },
  "/evidence": { group: "nav.assurance", page: "nav.evidence" },
  "/logs": { group: "nav.assurance", page: "nav.logs" },
  "/activity": { group: "nav.assurance", page: "nav.activity" },
  "/access": { group: "nav.system", page: "nav.access" },
  "/account": { group: "nav.system", page: "account.title" },
  "/help": { group: "nav.helpResources", page: "nav.helpCenter" },
};

export function ControlPlaneLayout() {
  const { t } = useTranslation();
  const auth = useAuth();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const location = names[pathname]
    ?? (pathname.startsWith("/guardrails/") ? names["/guardrails"] : undefined)
    ?? (pathname.startsWith("/deployments/") ? names["/deployments"] : undefined)
    ?? { group: "nav.home", page: "nav.dashboard" };
  const systemStatus = useQuery({ queryKey: ["controller", "system"], queryFn: getControllerSystemStatus, refetchInterval: 15_000, retry: false, enabled: Boolean(auth.status?.authenticated) });

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
              <Breadcrumb className="min-w-0">
                <BreadcrumbList className="flex-nowrap">
                  <BreadcrumbItem className="hidden sm:inline-flex">
                    <ShieldCheck className="size-4 text-primary" />
                    <span>TaskLattice Guard</span>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden sm:block" />
                  <BreadcrumbItem className="hidden md:inline-flex">{t(location.group)}</BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden md:block" />
                  <BreadcrumbItem className="min-w-0">
                    <BreadcrumbPage className="truncate">{t(location.page)}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </div>
            <RuntimeHealthMenu loading={systemStatus.isLoading} error={systemStatus.error} status={systemStatus.data} />
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

export function RuntimeHealthMenu({ loading, error, status }: { loading: boolean; error: unknown; status?: Awaited<ReturnType<typeof getControllerSystemStatus>> }) {
  const { t } = useTranslation();
  const degraded = Boolean(status?.status === "degraded");
  const unavailable = Boolean(error) || (!loading && !status);
  const healthLabel = t(loading ? "runtimeHealth.checking" : unavailable ? "runtimeHealth.unavailable" : degraded ? "runtimeHealth.attention" : "runtimeHealth.ready");
  const providerSummary = status
    ? `${status.modelConnections.controlPlane.provider} · ${status.modelConnections.dataPlane.provider}`
    : t("runtimeHealth.modelRouting");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="min-h-11 gap-2 px-3" aria-label={`${t("runtimeHealth.open")}: ${providerSummary}, ${healthLabel}`}>
          <span className={`size-2 rounded-full ${loading ? "bg-muted-foreground/50" : unavailable ? "bg-red-500" : degraded ? "bg-amber-500" : "bg-emerald-500"}`} />
          <span className="hidden text-left leading-tight sm:block">
            <span className="block text-xs font-medium text-foreground">{providerSummary}</span>
            <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">{healthLabel}</span>
          </span>
          <Gauge className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96 max-w-[calc(100vw-1rem)] p-2">
        <DropdownMenuLabel className="px-3 py-2"><span className="block text-sm font-semibold text-foreground">{t("runtimeHealth.title")}</span><span className="mt-1 block font-normal leading-5">{t(unavailable ? "runtimeHealth.unavailableDescription" : degraded ? "runtimeHealth.degradedDescription" : "runtimeHealth.readyDescription")}</span></DropdownMenuLabel>
        <DropdownMenuSeparator />
        <section className="px-2 py-2" aria-labelledby="runtime-model-connections">
          <h3 id="runtime-model-connections" className="px-1 text-[11px] font-medium text-muted-foreground">{t("runtimeHealth.modelConnections")}</h3>
          <div className="mt-2 overflow-hidden rounded-lg border bg-card">
            <ModelConnectionRow
              icon={<Bot className="size-4" />}
              plane={t("runtimeHealth.controlPlane")}
              provider={status?.modelConnections.controlPlane.provider}
              models={status ? [{ label: t("runtimeHealth.policyAnalysis"), model: status.modelConnections.controlPlane.model }] : []}
            />
            <ModelConnectionRow
              icon={<Server className="size-4" />}
              plane={t("runtimeHealth.dataPlane")}
              provider={status?.modelConnections.dataPlane.provider}
              models={status?.modelConnections.dataPlane.models.map((item) => ({ label: item.id, model: item.model })) ?? []}
              showCapabilities={false}
              ready={status?.defaultRunnerReady}
              className="border-t"
            />
          </div>
        </section>
        <div className="px-2 pb-2">
          <h3 className="px-1 text-[11px] font-medium text-muted-foreground">{t("runtimeHealth.runtimeState")}</h3>
          <div className="mt-2 grid grid-cols-2 divide-x overflow-hidden rounded-lg border bg-muted/30 text-xs">
            <div className="p-3"><p className="text-muted-foreground">{t("runtimeHealth.generation")}</p><p className="mt-1 font-mono text-sm text-foreground">{status?.desiredGeneration ?? "—"}</p></div>
            <div className="p-3"><p className="text-muted-foreground">{t("runtimeHealth.defaultRunner")}</p><p className="mt-1 text-sm font-medium text-foreground">{t(status?.defaultRunnerReady ? "runtimeHealth.runnerReady" : "runtimeHealth.runnerUnavailable")}</p></div>
          </div>
        </div>
        {unavailable ? <div className="mx-2 mb-2 flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-900"><CircleAlert className="mt-0.5 size-4 shrink-0" />{t("runtimeHealth.controllerUnavailable")}</div> : degraded ? <div className="mx-2 mb-2 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"><CircleAlert className="mt-0.5 size-4 shrink-0" />{t("runtimeHealth.runnerWarning")}</div> : <div className="mx-2 mb-2 flex gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900"><Activity className="mt-0.5 size-4 shrink-0" />{t("runtimeHealth.baselineReady")}</div>}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild><Link to="/runners"><Server />{t("runtimeHealth.openRunners")}</Link></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModelConnectionRow({ icon, plane, provider, models, showCapabilities = true, ready, className }: {
  icon: ReactNode;
  plane: string;
  provider?: string;
  models: Array<{ label: string; model: string }>;
  showCapabilities?: boolean;
  ready?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex gap-3 p-3 ${className ?? ""}`}>
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-h-8 items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] text-muted-foreground">{plane}</p>
            <p className="truncate text-sm font-semibold text-foreground">{provider ?? "—"}</p>
          </div>
          <span className={`size-2 shrink-0 rounded-full ${(ready ?? Boolean(provider)) ? "bg-emerald-500" : "bg-muted-foreground/35"}`} />
        </div>
        <div className="mt-2 space-y-1.5">
          {models.length ? models.map((item) => (
            <div key={`${item.label}-${item.model}`} className={showCapabilities ? "grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 text-[11px] leading-4" : "text-[11px] leading-4"}>
              {showCapabilities ? <span className="text-muted-foreground">{item.label}</span> : null}
              <span className="break-all font-mono text-foreground/80">{item.model}</span>
            </div>
          )) : <span className="text-[11px] text-muted-foreground">—</span>}
        </div>
      </div>
    </div>
  );
}
