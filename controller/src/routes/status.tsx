import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, CircleCheck, CircleHelp, CircleX, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/product-shell";
import { SettingsNavigation } from "@/components/settings-navigation";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { queryKeys } from "@/features/query-keys";
import { getControllerSystemHealth, type SystemHealthSnapshot } from "@/lib/controller-api";
import { cn } from "@/lib/utils";

type HealthState = SystemHealthSnapshot["status"] | "checking";

export function HealthPage() {
  const { t, i18n } = useTranslation();
  const query = useQuery({
    queryKey: queryKeys.systemHealth,
    queryFn: async ({ signal }) => {
      try {
        const snapshot = await getControllerSystemHealth(signal);
        return { snapshot: snapshot ?? null, attemptedAt: Date.now() };
      } catch {
        return { snapshot: null, attemptedAt: Date.now() };
      }
    },
    refetchInterval: 15_000,
    retry: false,
  });
  const loading = query.isLoading;
  const refreshing = query.isFetching;
  const snapshot = query.data?.snapshot;
  const state: HealthState = loading ? "checking" : snapshot?.status ?? "unknown";
  const controlPlane = snapshot?.components.controlPlane;
  const dataPlane = snapshot?.components.dataPlane;
  const controlReason = controlPlane?.reason ?? "unknown";
  const dataReason = dataPlane?.reason ?? "unknown";
  const counts = {
    total: dataPlane?.totalRunners ?? 0,
    connected: dataPlane?.connectedRunners ?? 0,
    unresponsive: dataPlane?.unresponsiveRunners ?? 0,
    seconds: dataPlane?.heartbeatTimeoutSeconds ?? 0,
  };
  const descriptionKey = loading ? "loadingDescription" : state === "unknown" ? "unknownDescription"
    : controlPlane?.status === "unhealthy" ? "controlPlaneFailure"
      : dataPlane?.reason === "no_runners" ? "noRunners"
        : state === "unhealthy" ? "runnersUnresponsive" : "healthyDescription";
  const checkedAt = snapshot?.observedAt ? Date.parse(snapshot.observedAt) : query.data?.attemptedAt;
  const checkedTime = checkedAt ? new Intl.DateTimeFormat(i18n.language, {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(checkedAt) : "—";
  const Icon = state === "healthy" ? CircleCheck : state === "unhealthy" ? CircleX : state === "checking" ? RefreshCw : CircleHelp;
  const feedback = loading ? "loadingDescription" : refreshing ? "refreshingPrevious"
    : state === "unknown" ? "refreshFailed" : "refreshComplete";

  return (
    <section className="health-page py-8">
      <PageHeader
        title={t("componentHealth.title")}
        description={t("componentHealth.description")}
        action={(
          <Button variant="outline" className="min-h-11 min-w-28 self-start" disabled={refreshing} onClick={() => void query.refetch()}>
            <RefreshCw className={cn(refreshing && "animate-spin motion-reduce:animate-none")} />
            {t(`componentHealth.${refreshing ? "refreshing" : state === "unknown" ? "retry" : "refresh"}`)}
          </Button>
        )}
      />
      <SettingsNavigation />
      <div className="health-panel mt-6 bg-card px-6 pb-3" aria-busy={refreshing}>
        <section className="health-summary" aria-labelledby="system-health-label">
          <div className="min-w-0 flex-1">
            <p id="system-health-label" className="mb-2 text-xs text-muted-foreground">{t("componentHealth.systemStatus")}</p>
            <div aria-live="polite" aria-atomic="true">
              <h2 className="health-conclusion" data-health={state}>
                <Icon aria-hidden="true" className={cn("size-6 shrink-0", loading && "animate-spin motion-reduce:animate-none")} />
                {t(`componentHealth.${state}`)}
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-6">{t(`componentHealth.${descriptionKey}`, counts)}</p>
            </div>
          </div>
          <div className="shrink-0 text-right text-xs leading-5 text-muted-foreground">
            <p>{t(`componentHealth.${state === "unknown" ? "lastAttempt" : "lastChecked"}`)}</p>
            <p className="my-1 text-sm tabular-nums text-foreground"><time dateTime={checkedAt ? new Date(checkedAt).toISOString() : undefined}>{checkedTime}</time></p>
            <p>{t("componentHealth.updates")}</p>
          </div>
        </section>
        <h3 id="health-components-heading" className="py-5 text-sm font-semibold">{t("componentHealth.componentDetails")}</h3>
        <Table className="health-table table-fixed" aria-labelledby="health-components-heading">
          <TableHeader>
            <TableRow>
              <TableHead className="w-1/4">{t("componentHealth.component")}</TableHead>
              <TableHead className="w-1/4">{t("componentHealth.status")}</TableHead>
              <TableHead className="w-1/2">{t("componentHealth.checkResult")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow data-health={controlPlane?.status ?? "unknown"}>
              <TableCell><p className="font-semibold">{t("componentHealth.controlPlane")}</p><p className="mt-1 text-muted-foreground">{t("componentHealth.controller")}</p></TableCell>
              <TableCell><ComponentStatus state={loading ? "checking" : controlPlane?.status ?? "unknown"} label={t(loading ? "componentHealth.checking" : `componentHealth.controlStatus.${controlReason}`)} /></TableCell>
              <TableCell>{loading ? "—" : t(`componentHealth.controlDetail.${controlReason}`)}</TableCell>
            </TableRow>
            <TableRow data-health={dataPlane?.status ?? "unknown"}>
              <TableCell><p className="font-semibold">{t("componentHealth.dataPlane")}</p><p className="mt-1 text-muted-foreground">{t("componentHealth.runners")}</p></TableCell>
              <TableCell><ComponentStatus state={loading ? "checking" : dataPlane?.status ?? "unknown"} label={t(loading ? "componentHealth.checking" : `componentHealth.dataStatus.${dataReason}`)} /></TableCell>
              <TableCell>
                <p>{loading ? "—" : t(`componentHealth.dataDetail.${dataReason}`, counts)}</p>
                <Link className="health-runner-link" to="/settings/runner">{t("componentHealth.viewRunners")}<ArrowRight aria-hidden="true" className="size-4" /></Link>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <p className="health-feedback text-xs text-muted-foreground" role="status">{t(`componentHealth.${feedback}`)}</p>
      </div>
    </section>
  );
}

function ComponentStatus({ state, label }: { state: HealthState; label: string }) {
  return <span className="health-component-state" data-health={state}><span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />{label}</span>;
}
