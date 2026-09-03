import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Activity, Bot, CircleAlert, RefreshCw, Server, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { PageHeader, StateBadge } from "@/components/product-shell";
import { SettingsNavigation } from "@/components/settings-navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getControllerSystemStatus, type SystemStatus } from "@/lib/controller-api";
import { queryKeys } from "@/features/query-keys";
import { cn } from "@/lib/utils";

type HealthState = "healthy" | "degraded" | "unknown";

export function StatusPage() {
  const { t, i18n } = useTranslation();
  const query = useQuery({
    queryKey: queryKeys.systemStatus,
    queryFn: getPlatformStatusSnapshot,
    refetchInterval: 15_000,
    retry: false,
  });
  const status = query.data?.status;
  const unavailable = Boolean(query.data?.error) || (!query.isLoading && !status);
  const overallState: HealthState = unavailable
    ? "unknown"
    : status?.status === "degraded"
      ? "degraded"
      : "healthy";
  const lastChecked = query.dataUpdatedAt
    ? new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(query.dataUpdatedAt)
    : null;

  return (
    <section className="py-6 sm:py-8">
      <PageHeader
        title={t("platformStatus.title")}
        description={t("platformStatus.description")}
        action={(
          <Button
            type="button"
            variant="outline"
            className="min-h-11 self-start"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw className={cn(query.isFetching && "animate-spin motion-reduce:animate-none")} />
            {t(query.isFetching ? "platformStatus.refreshing" : "platformStatus.refresh")}
          </Button>
        )}
      />
      <SettingsNavigation />

      {query.isLoading ? <StatusSkeleton /> : (
        <div className="mt-6 space-y-5">
          <section
            role="status"
            aria-live="polite"
            className={cn(
              "flex flex-col gap-4 rounded-lg border px-5 py-4 sm:flex-row sm:items-center sm:justify-between",
              overallState === "healthy" && "border-emerald-200 bg-emerald-50/60",
              overallState === "degraded" && "border-amber-200 bg-amber-50/70",
              overallState === "unknown" && "border-red-200 bg-red-50/70",
            )}
          >
            <div className="flex min-w-0 items-start gap-3">
              <OverallIcon state={overallState} />
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold">{t(`platformStatus.overall.${overallState}`)}</h2>
                  <HealthBadge state={overallState} label={t(`platformStatus.state.${overallState}`)} />
                </div>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{t(`platformStatus.overall.${overallState}Description`)}</p>
              </div>
            </div>
            {lastChecked ? <p className="shrink-0 text-xs text-muted-foreground">{t("platformStatus.lastChecked", { time: lastChecked })}</p> : null}
          </section>

          {unavailable ? (
            <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-card px-5 py-4 text-sm text-red-950">
              <CircleAlert className="mt-0.5 size-5 shrink-0 text-red-600" />
              <div>
                <p className="font-semibold">{t("platformStatus.statusUnavailable")}</p>
                <p className="mt-1 leading-6 text-muted-foreground">{t("platformStatus.statusUnavailableDescription")}</p>
              </div>
            </div>
          ) : null}

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.55fr)]">
            <section className="overflow-hidden rounded-lg border bg-card" aria-labelledby="platform-components-title">
              <div className="border-b px-5 py-4">
                <h2 id="platform-components-title" className="text-base font-semibold">{t("platformStatus.components")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t("platformStatus.componentsDescription")}</p>
              </div>
              <div className="divide-y">
                <StatusRow
                  icon={<ShieldCheck />}
                  title={t("platformStatus.controller")}
                  description={t(unavailable ? "platformStatus.controllerUnknownDescription" : "platformStatus.controllerHealthyDescription")}
                  state={unavailable ? "unknown" : "healthy"}
                  stateLabel={t(unavailable ? "platformStatus.state.unknown" : "platformStatus.state.operational")}
                />
                <StatusRow
                  icon={<Server />}
                  title={t("platformStatus.defaultRunner")}
                  description={t(unavailable
                    ? "platformStatus.runnerUnknownDescription"
                    : status?.defaultRunnerReady
                      ? "platformStatus.runnerHealthyDescription"
                      : "platformStatus.runnerDegradedDescription")}
                  state={unavailable ? "unknown" : status?.defaultRunnerReady ? "healthy" : "degraded"}
                  stateLabel={t(unavailable
                    ? "platformStatus.state.unknown"
                    : status?.defaultRunnerReady
                      ? "platformStatus.state.ready"
                      : "platformStatus.state.unavailable")}
                />
              </div>
            </section>

            <section className="rounded-lg border bg-card px-5 py-4" aria-labelledby="runtime-state-title">
              <h2 id="runtime-state-title" className="text-base font-semibold">{t("platformStatus.runtimeState")}</h2>
              <dl className="mt-4 divide-y">
                <RuntimeDatum label={t("platformStatus.desiredGeneration")} value={status?.desiredGeneration ?? "—"} mono />
                <RuntimeDatum label={t("platformStatus.defaultRunner")} value={t(unavailable
                  ? "platformStatus.state.unknown"
                  : status?.defaultRunnerReady
                    ? "platformStatus.state.ready"
                    : "platformStatus.state.unavailable")} />
                <RuntimeDatum label={t("platformStatus.refreshInterval")} value={t("platformStatus.everyFifteenSeconds")} />
              </dl>
              <Button asChild variant="link" className="mt-3 h-11 px-0">
                <Link to="/runners">{t("platformStatus.openRunnerCapacity")}<span aria-hidden="true">→</span></Link>
              </Button>
            </section>
          </div>

          <ModelStatus status={status ?? undefined} unavailable={unavailable} />
        </div>
      )}
    </section>
  );
}

async function getPlatformStatusSnapshot(): Promise<{ status: SystemStatus | null; error: unknown | null }> {
  try {
    return { status: await getControllerSystemStatus(), error: null };
  } catch (error) {
    return { status: null, error };
  }
}

function ModelStatus({ status, unavailable }: { status?: SystemStatus; unavailable: boolean }) {
  const { t } = useTranslation();
  const runtimeState: HealthState = unavailable ? "unknown" : status?.defaultRunnerReady ? "healthy" : "degraded";
  return (
    <section className="overflow-hidden rounded-lg border bg-card" aria-labelledby="model-status-title">
      <div className="border-b px-5 py-4">
        <h2 id="model-status-title" className="text-base font-semibold">{t("platformStatus.modelConnections")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("platformStatus.modelConnectionsDescription")}</p>
      </div>
      <div className="divide-y">
        <div className="grid gap-4 px-5 py-5 lg:grid-cols-[12rem_minmax(0,1fr)_auto] lg:items-center">
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><Bot className="size-4" /></span>
            <div>
              <p className="text-sm font-semibold">{t("platformStatus.controlPlaneModel")}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t("platformStatus.policyAnalysis")}</p>
            </div>
          </div>
          <ModelIdentity provider={status?.modelConnections.controlPlane.provider} model={status?.modelConnections.controlPlane.model} />
          <StateBadge
            state={unavailable ? "unknown" : "configured"}
            label={t(unavailable ? "platformStatus.state.unknown" : "platformStatus.state.configured")}
          />
        </div>
        <div className="grid gap-4 px-5 py-5 lg:grid-cols-[12rem_minmax(0,1fr)_auto] lg:items-start">
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><Server className="size-4" /></span>
            <div>
              <p className="text-sm font-semibold">{t("platformStatus.runtimeModels")}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{status?.modelConnections.dataPlane.provider ?? "—"}</p>
            </div>
          </div>
          <div className="min-w-0 space-y-3">
            {(status?.modelConnections.dataPlane.models ?? []).length ? status!.modelConnections.dataPlane.models.map((model) => (
              <div key={`${model.id}-${model.model}`} className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3">
                <span className="text-xs font-medium text-foreground">{model.id}</span>
                <code className="break-all text-xs text-muted-foreground">{model.model}</code>
              </div>
            )) : <p className="text-sm text-muted-foreground">{t(unavailable ? "platformStatus.modelsUnknown" : "platformStatus.noRuntimeModels")}</p>}
          </div>
          <StateBadge
            state={runtimeState}
            label={t(runtimeState === "healthy"
              ? "platformStatus.state.runtimeReady"
              : runtimeState === "degraded"
                ? "platformStatus.state.unavailable"
                : "platformStatus.state.unknown")}
          />
        </div>
      </div>
      <div className="border-t bg-muted/35 px-5 py-3 text-xs leading-5 text-muted-foreground">
        {t("platformStatus.readinessEvidence")}
      </div>
    </section>
  );
}

function StatusRow({ icon, title, description, state, stateLabel }: {
  icon: ReactNode;
  title: string;
  description: string;
  state: HealthState;
  stateLabel: string;
}) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&>svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <HealthBadge state={state} label={stateLabel} />
    </div>
  );
}

function HealthBadge({ state, label }: { state: HealthState; label: string }) {
  return <StateBadge state={state === "degraded" ? "busy" : state} label={label} />;
}

function RuntimeDatum({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm font-medium text-foreground", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

function ModelIdentity({ provider, model }: { provider?: string; model?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-sm font-medium text-foreground">{provider ?? "—"}</p>
      <code className="mt-1 block break-all text-xs text-muted-foreground">{model ?? "—"}</code>
    </div>
  );
}

function OverallIcon({ state }: { state: HealthState }) {
  const Icon = state === "healthy" ? Activity : CircleAlert;
  return (
    <span className={cn(
      "grid size-9 shrink-0 place-items-center rounded-md",
      state === "healthy" && "bg-emerald-100 text-emerald-700",
      state === "degraded" && "bg-amber-100 text-amber-800",
      state === "unknown" && "bg-red-100 text-red-700",
    )}>
      <Icon className="size-4" />
    </span>
  );
}

function StatusSkeleton() {
  return (
    <div className="mt-6 space-y-5" aria-label="Loading platform status">
      <Skeleton className="h-24 rounded-lg" />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.55fr)]">
        <Skeleton className="h-56 rounded-lg" />
        <Skeleton className="h-56 rounded-lg" />
      </div>
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}
