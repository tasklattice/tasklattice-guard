import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, CircleAlert, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PageHeader, StateBadge } from "@/components/product-shell";
import { RunnerCapacitySection, runnerPoolKey } from "@/components/runner-capacity";
import { SettingsNavigation } from "@/components/settings-navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getControllerSystemStatus, type SystemStatus } from "@/lib/controller-api";
import { queryKeys } from "@/features/query-keys";
import { cn } from "@/lib/utils";

type PlatformDisplayStatus = SystemStatus["status"] | "unknown";

export function StatusPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.systemStatus,
    queryFn: getPlatformStatusSnapshot,
    refetchInterval: 15_000,
    retry: false,
  });
  const runnerQueriesFetching = useIsFetching({ queryKey: runnerPoolKey });
  const refreshing = query.isFetching || runnerQueriesFetching > 0;
  const snapshot = query.data?.status;
  const requestUnavailable = Boolean(query.data?.error) || (!query.isLoading && !snapshot);
  const overallState: PlatformDisplayStatus = requestUnavailable ? "unknown" : snapshot?.status ?? "unknown";
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
          <Button
            type="button"
            variant="outline"
            className="min-h-11 self-start"
            disabled={refreshing}
            onClick={() => void Promise.all([
              query.refetch(),
              queryClient.invalidateQueries({ queryKey: runnerPoolKey }),
            ])}
          >
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
              "rounded-lg border px-5 py-4",
              overallState === "healthy" && "border-emerald-200 bg-emerald-50/60",
              ["initializing", "degraded"].includes(overallState) && "border-amber-200 bg-amber-50/70",
              ["unavailable", "unknown"].includes(overallState) && "border-red-200 bg-red-50/70",
            )}
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <OverallIcon state={overallState} />
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold">{t(`platformStatus.overall.${overallState}`)}</h2>
                    <HealthBadge state={overallState} label={t(`platformStatus.state.${overallState}`)} />
                  </div>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{t(`platformStatus.overall.${overallState}Description`)}</p>
                  {!requestUnavailable && snapshot && snapshot.reasons[0] !== "all_required_components_ready" ? (
                    <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
                      {snapshot.reasons.map((reason) => <li key={reason}>• {t(`platformStatus.reason.${reason}`)}</li>)}
                    </ul>
                  ) : null}
                </div>
              </div>
              {lastChecked ? <p className="shrink-0 text-xs text-muted-foreground">{t("platformStatus.lastChecked", { time: lastChecked })}</p> : null}
            </div>
            <dl className="mt-4 grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-3">
              <StatusDatum
                label={t("platformStatus.controller")}
                value={t(requestUnavailable ? "platformStatus.state.unknown" : "platformStatus.state.operational")}
              />
              <StatusDatum
                label={t("platformStatus.defaultRunner")}
                value={t(`platformStatus.state.${requestUnavailable ? "unknown" : snapshot!.components.runnerFleet.status}`)}
              />
              <StatusDatum
                label={t("platformStatus.desiredGeneration")}
                value={String(snapshot?.desiredGeneration ?? "—")}
                mono
              />
            </dl>
          </section>

          {requestUnavailable ? (
            <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-card px-5 py-4 text-sm text-red-950">
              <CircleAlert className="mt-0.5 size-5 shrink-0 text-red-600" />
              <div>
                <p className="font-semibold">{t("platformStatus.statusUnavailable")}</p>
                <p className="mt-1 leading-6 text-muted-foreground">{t("platformStatus.statusUnavailableDescription")}</p>
              </div>
            </div>
          ) : null}

          <RunnerCapacitySection />
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

function StatusDatum({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-background/80 px-4 py-3">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 text-sm font-semibold", mono && "font-mono tabular-nums")}>{value}</dd>
    </div>
  );
}

function HealthBadge({ state, label }: { state: PlatformDisplayStatus; label: string }) {
  const badgeState = state === "degraded" ? "busy"
    : state === "initializing" ? "syncing"
      : state === "unavailable" ? "offline"
        : state;
  return <StateBadge state={badgeState} label={label} />;
}

function OverallIcon({ state }: { state: PlatformDisplayStatus }) {
  const Icon = state === "healthy" ? Activity : state === "initializing" ? RefreshCw : CircleAlert;
  return (
    <span className={cn(
      "grid size-9 shrink-0 place-items-center rounded-md",
      state === "healthy" && "bg-emerald-100 text-emerald-700",
      ["initializing", "degraded"].includes(state) && "bg-amber-100 text-amber-800",
      ["unavailable", "unknown"].includes(state) && "bg-red-100 text-red-700",
    )}>
      <Icon className={cn("size-4", state === "initializing" && "animate-spin motion-reduce:animate-none")} />
    </span>
  );
}

function StatusSkeleton() {
  return (
    <div className="mt-6 space-y-5" aria-label="Loading platform status">
      <Skeleton className="h-40 rounded-lg" />
      <Skeleton className="h-[32rem] rounded-lg" />
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}
