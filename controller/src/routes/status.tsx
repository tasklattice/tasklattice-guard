import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  CircleAlert,
  RefreshCw,
  Route,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { PageHeader, StateBadge } from "@/components/product-shell";
import { SettingsNavigation } from "@/components/settings-navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getControllerSystemStatus, type SystemStatus } from "@/lib/controller-api";
import { queryKeys } from "@/features/query-keys";
import { cn } from "@/lib/utils";

type PlatformDisplayStatus = SystemStatus["status"] | "unknown";
type BasicDisplayStatus = SystemStatus["components"]["basicProtection"]["status"] | "unknown";

export function HealthPage() {
  const { t, i18n } = useTranslation();
  const query = useQuery({
    queryKey: queryKeys.systemStatus,
    queryFn: getPlatformStatusSnapshot,
    refetchInterval: 15_000,
    retry: false,
  });
  const refreshing = query.isFetching;
  const snapshot = query.data?.status;
  const requestUnavailable = Boolean(query.data?.error) || (!query.isLoading && !snapshot);
  const overallState: PlatformDisplayStatus = requestUnavailable ? "unknown" : snapshot?.status ?? "unknown";
  const basicProtection = snapshot?.components.basicProtection;
  const basicState: BasicDisplayStatus = requestUnavailable ? "unknown" : basicProtection?.status ?? "unknown";
  const observedAt = snapshot?.observedAt ? Date.parse(snapshot.observedAt) : query.dataUpdatedAt;
  const lastChecked = observedAt
    ? new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(observedAt)
    : null;

  return (
    <section className="py-6 sm:py-8">
      <PageHeader
        title={t("platformStatus.title")}
        description={t("platformStatus.description")}
        action={(
          <Button type="button" variant="outline" className="min-h-11 self-start" disabled={refreshing} onClick={() => void query.refetch()}>
            <RefreshCw className={cn(refreshing && "animate-spin motion-reduce:animate-none")} />
            {t(refreshing ? "platformStatus.refreshing" : "platformStatus.refresh")}
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
              "overflow-hidden rounded-xl border bg-card",
              basicState === "ready" && "border-emerald-200",
              basicState === "initializing" && "border-amber-200",
              ["unavailable", "unknown"].includes(basicState) && "border-red-200",
            )}
          >
            <div className={cn(
              "flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-start sm:justify-between sm:px-6",
              basicState === "ready" && "bg-emerald-50/60",
              basicState === "initializing" && "bg-amber-50/70",
              ["unavailable", "unknown"].includes(basicState) && "bg-red-50/70",
            )}>
              <div className="flex min-w-0 items-start gap-3">
                <OverallIcon state={basicState} />
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("platformStatus.basic.eyebrow")}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold">{t(`platformStatus.basic.${basicState}`)}</h2>
                    <BasicHealthBadge state={basicState} label={t(`platformStatus.state.${basicState}`)} />
                  </div>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{t(`platformStatus.basic.${basicState}Description`)}</p>
                </div>
              </div>
              {lastChecked ? <p className="shrink-0 text-xs text-muted-foreground">{t("platformStatus.lastChecked", { time: lastChecked })}</p> : null}
            </div>

            <div className="grid border-t sm:grid-cols-3 sm:divide-x">
              <Requirement icon={Activity} label={t("platformStatus.controller")} value={t(requestUnavailable ? "platformStatus.state.unknown" : "platformStatus.state.operational")} ready={!requestUnavailable} />
              <Requirement
                icon={ShieldCheck}
                label={t("platformStatus.defaultGuardrail")}
                value={basicProtection?.guardrailStatus === "active" && basicProtection.activeVersion
                  ? t("platformStatus.activeVersion", { version: basicProtection.activeVersion })
                  : t(`platformStatus.state.${basicProtection?.guardrailStatus ?? "unknown"}`)}
                ready={basicProtection?.guardrailStatus === "active"}
              />
              <Requirement
                icon={Server}
                label={t("platformStatus.defaultRunner")}
                value={snapshot ? t("platformStatus.servingRunners", { count: snapshot.components.runnerFleet.servingRunners }) : t("platformStatus.state.unknown")}
                ready={Boolean(snapshot?.components.runnerFleet.servingRunners)}
              />
            </div>
          </section>

          {!requestUnavailable && snapshot ? (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)]">
              <section className="rounded-xl border bg-card" aria-labelledby="minimum-protection-title">
                <div className="border-b px-5 py-4">
                  <h2 id="minimum-protection-title" className="font-semibold">{t("platformStatus.minimum.title")}</h2>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("platformStatus.minimum.description")}</p>
                </div>
                <div className="p-5">
                  <div className={cn(
                    "flex items-start gap-3 rounded-lg border p-4",
                    basicState === "ready" ? "border-emerald-200 bg-emerald-50/40" : "bg-muted/20",
                  )}>
                    <ShieldCheck className={cn("mt-0.5 size-5 shrink-0", basicState === "ready" ? "text-emerald-700" : "text-muted-foreground")} />
                    <div>
                      <p className="text-sm font-semibold">{t("platformStatus.minimum.modelFreeTitle")}</p>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("platformStatus.minimum.modelFreeDescription")}</p>
                    </div>
                  </div>
                  <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                    <StatusDatum label={t("platformStatus.defaultRoute")} value={t(`platformStatus.state.${basicProtection?.deploymentStatus ?? "unknown"}`)} />
                    <StatusDatum label={t("platformStatus.desiredGeneration")} value={String(snapshot.desiredGeneration)} mono />
                  </dl>
                  <Button asChild variant="outline" className="mt-4 min-h-11">
                    <Link to="/guardrails/$guardrailId" params={{ guardrailId: "guardrail-default" }}>
                      {t("platformStatus.minimum.openDefault")}<ArrowRight />
                    </Link>
                  </Button>
                </div>
              </section>

              <section className="rounded-xl border bg-card" aria-labelledby="model-coverage-title">
                <div className="border-b px-5 py-4">
                  <h2 id="model-coverage-title" className="font-semibold">{t("platformStatus.models.title")}</h2>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("platformStatus.models.description")}</p>
                </div>
                <div className="divide-y">
                  <ModelCoverageRow icon={Bot} title={t("platformStatus.models.controlPlane")} status={snapshot.components.controlPlaneModel.status} detail={snapshot.components.controlPlaneModel.model ?? t("platformStatus.models.notConfiguredDetail")} />
                  <ModelCoverageRow
                    icon={Route}
                    title={t("platformStatus.models.dataPlane")}
                    status={snapshot.components.runtimeModels.status}
                    detail={snapshot.components.runtimeModels.models.length ? t("platformStatus.models.modelCount", { count: snapshot.components.runtimeModels.models.length }) : t("platformStatus.models.notConfiguredDetail")}
                  />
                </div>
                <div className="flex flex-wrap gap-2 border-t p-4">
                  <Button asChild variant="outline" size="sm" className="min-h-10"><Link to="/settings/models">{t("platformStatus.models.configure")}<ArrowRight /></Link></Button>
                  <Button asChild variant="ghost" size="sm" className="min-h-10"><Link to="/settings/guardrail-catalog">{t("platformStatus.models.assign")}<ArrowRight /></Link></Button>
                </div>
              </section>
            </div>
          ) : null}

          {!requestUnavailable && snapshot && overallState !== "healthy" && snapshot.reasons[0] !== "all_required_components_ready" ? (
            <section className="rounded-xl border bg-card px-5 py-4" aria-labelledby="attention-title">
              <div className="flex items-start gap-3">
                <CircleAlert className="mt-0.5 size-5 shrink-0 text-amber-700" />
                <div>
                  <h2 id="attention-title" className="text-sm font-semibold">{t("platformStatus.attention")}</h2>
                  <ul className="mt-1 space-y-1 text-sm leading-6 text-muted-foreground">
                    {snapshot.reasons.map((reason) => <li key={reason}>• {t(`platformStatus.reason.${reason}`)}</li>)}
                  </ul>
                </div>
              </div>
            </section>
          ) : null}

          {requestUnavailable ? (
            <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-card px-5 py-4 text-sm text-red-950">
              <CircleAlert className="mt-0.5 size-5 shrink-0 text-red-600" />
              <div><p className="font-semibold">{t("platformStatus.statusUnavailable")}</p><p className="mt-1 leading-6 text-muted-foreground">{t("platformStatus.statusUnavailableDescription")}</p></div>
            </div>
          ) : null}
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

function Requirement({ icon: Icon, label, value, ready }: { icon: typeof Activity; label: string; value: string; ready: boolean }) {
  return (
    <div className="flex min-w-0 items-start gap-3 border-b px-5 py-4 last:border-b-0 sm:border-b-0">
      <span className={cn("grid size-8 shrink-0 place-items-center rounded-md", ready ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground")}>{ready ? <CheckCircle2 className="size-4" /> : <Icon className="size-4" />}</span>
      <div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-0.5 truncate text-sm font-semibold" title={value}>{value}</p></div>
    </div>
  );
}

function StatusDatum({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="rounded-lg border bg-muted/20 px-4 py-3"><dt className="text-xs text-muted-foreground">{label}</dt><dd className={cn("mt-1 text-sm font-semibold", mono && "font-mono tabular-nums")}>{value}</dd></div>;
}

function ModelCoverageRow({ icon: Icon, title, status, detail }: { icon: typeof Bot; title: string; status: "configured" | "unconfigured" | "ready" | "unavailable"; detail: string }) {
  const { t } = useTranslation();
  const badgeState = status === "ready" ? "healthy" : status === "unavailable" ? "offline" : status === "configured" ? "neutral" : "pending";
  return (
    <div className="flex items-start gap-3 px-5 py-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><Icon className="size-4" /></span>
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold">{title}</p><StateBadge state={badgeState} label={t(`platformStatus.state.${status}`)} /></div><p className="mt-1 truncate text-xs text-muted-foreground" title={detail}>{detail}</p></div>
    </div>
  );
}

function BasicHealthBadge({ state, label }: { state: BasicDisplayStatus; label: string }) {
  const badgeState = state === "initializing" ? "syncing" : state === "unavailable" ? "offline" : state;
  return <StateBadge state={badgeState} label={label} />;
}

function OverallIcon({ state }: { state: BasicDisplayStatus }) {
  const Icon = state === "ready" ? ShieldCheck : state === "initializing" ? RefreshCw : CircleAlert;
  return <span className={cn("grid size-10 shrink-0 place-items-center rounded-lg", state === "ready" && "bg-emerald-100 text-emerald-700", state === "initializing" && "bg-amber-100 text-amber-800", ["unavailable", "unknown"].includes(state) && "bg-red-100 text-red-700")}><Icon className={cn("size-5", state === "initializing" && "animate-spin motion-reduce:animate-none")} /></span>;
}

function StatusSkeleton() {
  return <div className="mt-6 space-y-5" aria-label="Loading platform health"><Skeleton className="h-56 rounded-xl" /><div className="grid gap-5 lg:grid-cols-2"><Skeleton className="h-72 rounded-xl" /><Skeleton className="h-72 rounded-xl" /></div></div>;
}
