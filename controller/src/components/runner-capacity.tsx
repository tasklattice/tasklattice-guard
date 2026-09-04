import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Gauge, RefreshCw, Trash2, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { EntitySheet } from "@/components/entity-sheet";
import { EmptyState, ErrorNotice, StateBadge } from "@/components/product-shell";
import { ProtectedDeleteSheet } from "@/components/protected-delete-sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import {
  listRunnerPools,
  removeRunnerInstance,
  updateRunnerPool,
  type RunnerInstance,
  type RunnerPool,
} from "@/lib/controller-api";
import { cn } from "@/lib/utils";

export const runnerPoolKey = ["resources", "runner-pools"] as const;

export function RunnerCapacitySection() {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: runnerPoolKey, queryFn: listRunnerPools, refetchInterval: 10_000 });
  const [editing, setEditing] = useState<RunnerPool | null>(null);
  const [removing, setRemoving] = useState<{ runner: RunnerInstance; poolName: string } | null>(null);

  return (
    <section className="overflow-hidden rounded-lg border bg-card" aria-labelledby="runner-capacity-title">
      <header className="border-b px-5 py-4">
        <h2 id="runner-capacity-title" className="text-base font-semibold">{t("runners.title")}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("runners.description")}</p>
      </header>
      {query.isLoading ? <div className="p-5"><Skeleton className="h-80 rounded-lg" /></div> : null}
      {query.error ? <div className="p-5"><ErrorNotice error={query.error} /></div> : null}
      {!query.isLoading && !query.error && !query.data?.items.length ? <div className="p-5"><EmptyState title={t("runners.emptyTitle")} description={t("runners.emptyDescription")} /></div> : null}
      <div className="divide-y">
        {(query.data?.items ?? []).map((pool) => (
          <article key={pool.id}>
            <div className="flex flex-col gap-4 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold">{pool.name}</h3>
                  {pool.isDefault ? <Badge>Baseline</Badge> : null}
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t("runners.recommendation", { recommended: pool.capacity.recommendedReplicas, desired: pool.desiredReplicas })}
                </p>
              </div>
              <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center lg:w-auto">
                <PoolConvergenceStatus pool={pool} />
                {auth.user?.role === "admin" ? (
                  <Button variant="outline" className="min-h-11" onClick={() => setEditing(pool)}>
                    <Gauge />{t("runners.capacitySettings")}
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="grid gap-px border-y bg-border sm:grid-cols-2 xl:grid-cols-5">
              <RunnerMetric label={t("runners.readyRunners")} value={`${pool.capacity.readyRunners}/${pool.capacity.totalRunners}`} />
              <RunnerMetric label="RPS" value={pool.capacity.currentRps.toFixed(1)} detail={`${t("runners.safeCapacity")} ${pool.capacity.safeRpsCapacity.toFixed(1)}`} />
              <RunnerMetric label={t("runners.inflightUtilization")} value={`${Math.round(pool.capacity.inflightUtilization * 100)}%`} />
              <RunnerMetric label="p95" value={`${Math.round(pool.capacity.latencyP95Ms)} ms`} />
              <RunnerMetric label={t("runners.errorRate")} value={`${(pool.capacity.errorRate * 100).toFixed(2)}%`} />
            </div>
            <div className="hidden overflow-x-auto lg:block">
              <Table className="min-w-[64rem]">
                <TableHeader><TableRow><TableHead>Runner</TableHead><TableHead>{t("runners.columns.runtimeState")}</TableHead><TableHead>{t("runners.columns.configurationSync")}</TableHead><TableHead>{t("runners.columns.inflightQueue")}</TableHead><TableHead>CPU / Memory</TableHead><TableHead>{t("runners.columns.lastHeartbeat")}</TableHead><TableHead className="w-14"><span className="sr-only">{t("runners.columns.actions")}</span></TableHead></TableRow></TableHeader>
                <TableBody>
                  {pool.instances.map((runner) => (
                    <TableRow key={runner.runnerId}>
                      <TableCell><code className="text-xs">{runner.runnerId}</code><p className="mt-1 text-xs text-muted-foreground">NeMo {runner.nemoVersion}{runner.compilerCapable ? " · compiler" : ""}</p></TableCell>
                      <TableCell><StateBadge state={runner.status} /></TableCell>
                      <TableCell><RunnerConvergenceStatus runner={runner} /></TableCell>
                      <TableCell>{runner.load?.inflight ?? 0} / {runner.load?.queueDepth ?? 0}</TableCell>
                      <TableCell>{Math.round((runner.load?.cpuUtilization ?? 0) * 100)}% / {Math.round((runner.load?.memoryUtilization ?? 0) * 100)}%</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDate(runner.lastHeartbeatAt, i18n.language)}</TableCell>
                      <TableCell className="text-right">
                        {auth.user?.role === "admin" && runner.status === "offline" ? <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="size-11 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          aria-label={t("runners.removeAria", { runnerId: runner.runnerId })}
                          title={t("runners.removeOffline")}
                          onClick={() => setRemoving({ runner, poolName: pool.name })}
                        ><Trash2 /></Button> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="divide-y lg:hidden">
              {pool.instances.map((runner) => (
                <div key={runner.runnerId} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <code className="break-all text-xs">{runner.runnerId}</code>
                      <p className="mt-1 text-xs text-muted-foreground">NeMo {runner.nemoVersion}{runner.compilerCapable ? " · compiler" : ""}</p>
                    </div>
                    <StateBadge state={runner.status} />
                  </div>
                  <div className="mt-4"><RunnerConvergenceStatus runner={runner} /></div>
                  <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
                    <RunnerDatum label={t("runners.columns.inflightQueue")} value={`${runner.load?.inflight ?? 0} / ${runner.load?.queueDepth ?? 0}`} />
                    <RunnerDatum label="CPU / Memory" value={`${Math.round((runner.load?.cpuUtilization ?? 0) * 100)}% / ${Math.round((runner.load?.memoryUtilization ?? 0) * 100)}%`} />
                    <RunnerDatum label={t("runners.columns.lastHeartbeat")} value={formatDate(runner.lastHeartbeatAt, i18n.language)} />
                  </dl>
                  {auth.user?.role === "admin" && runner.status === "offline" ? <Button
                    type="button"
                    variant="outline"
                    className="mt-4 min-h-11 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    aria-label={t("runners.removeAria", { runnerId: runner.runnerId })}
                    onClick={() => setRemoving({ runner, poolName: pool.name })}
                  ><Trash2 />{t("runners.removeOffline")}</Button> : null}
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
      <RunnerPoolSheet
        pool={editing}
        onOpenChange={(open) => { if (!open) setEditing(null); }}
        onSaved={async () => {
          setEditing(null);
          await queryClient.invalidateQueries({ queryKey: runnerPoolKey });
        }}
      />
      <RemoveRunnerSheet
        key={removing?.runner.runnerId ?? "closed"}
        target={removing}
        onOpenChange={(open) => { if (!open) setRemoving(null); }}
        onRemoved={async () => {
          setRemoving(null);
          await queryClient.invalidateQueries({ queryKey: runnerPoolKey });
        }}
      />
    </section>
  );
}

function RunnerMetric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="bg-card px-5 py-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-xl font-semibold tracking-[-0.025em] tabular-nums">{value}</p>
      {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function RunnerDatum({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-xs font-medium tabular-nums">{value}</dd>
    </div>
  );
}

type ConvergenceState = "converged" | "syncing" | "unavailable";

function runnerConvergenceState(runner: RunnerInstance): ConvergenceState {
  if (runner.status === "offline") return "unavailable";
  return runner.appliedGeneration === runner.desiredGeneration ? "converged" : "syncing";
}

function PoolConvergenceStatus({ pool }: { pool: RunnerPool }) {
  const { t } = useTranslation();
  const connected = pool.instances.filter((runner) => runner.status !== "offline");
  const converged = connected.filter((runner) => runnerConvergenceState(runner) === "converged");
  const desiredGeneration = Math.max(0, ...(
    connected.length > 0 ? connected : pool.instances
  ).map((runner) => runner.desiredGeneration));
  const state: ConvergenceState = connected.length === 0
    ? "unavailable"
    : converged.length === connected.length
      ? "converged"
      : "syncing";
  const Icon = state === "converged" ? CheckCircle2 : state === "syncing" ? RefreshCw : WifiOff;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "min-w-0 rounded-lg border px-3.5 py-2.5 sm:min-w-72",
        state === "converged" && "border-emerald-200 bg-emerald-50/60 text-emerald-950",
        state === "syncing" && "border-amber-200 bg-amber-50/70 text-amber-950",
        state === "unavailable" && "border-red-200 bg-red-50/70 text-red-950",
      )}
    >
      <p className={cn(
        "flex items-center gap-2 text-xs font-medium",
        state === "converged" && "text-emerald-700",
        state === "syncing" && "text-amber-800",
        state === "unavailable" && "text-red-700",
      )}>
        <Icon className={cn("size-4 shrink-0", state === "syncing" && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
        {t(`runners.convergence.${state}`)}
      </p>
      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
        {connected.length > 0
          ? t("runners.convergence.poolSummary", {
            converged: converged.length,
            connected: connected.length,
            generation: desiredGeneration,
          })
          : t("runners.convergence.noConnectedSummary", { generation: desiredGeneration })}
      </p>
    </div>
  );
}

function RunnerConvergenceStatus({ runner }: { runner: RunnerInstance }) {
  const { t } = useTranslation();
  const state = runnerConvergenceState(runner);
  const Icon = state === "converged" ? CheckCircle2 : state === "syncing" ? RefreshCw : WifiOff;
  const lag = Math.max(0, runner.desiredGeneration - runner.appliedGeneration);

  return (
    <div className="min-w-44" data-convergence-state={state}>
      <p className={cn(
        "flex items-center gap-1.5 text-xs font-medium",
        state === "converged" && "text-emerald-700",
        state === "syncing" && "text-amber-800",
        state === "unavailable" && "text-red-700",
      )}>
        <Icon className={cn("size-3.5 shrink-0", state === "syncing" && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
        {t(`runners.convergence.runner.${state}`)}
      </p>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
        {state === "unavailable"
          ? t("runners.convergence.lastReported", {
            applied: runner.appliedGeneration,
            desired: runner.desiredGeneration,
          })
          : t("runners.convergence.appliedDesired", {
            applied: runner.appliedGeneration,
            desired: runner.desiredGeneration,
          })}
      </p>
      {state === "syncing" ? <p className="mt-0.5 text-[11px] text-amber-800">
        {lag > 0
          ? t("runners.convergence.generationsBehind", { count: lag })
          : t("runners.convergence.generationMismatch")}
      </p> : null}
    </div>
  );
}

function RemoveRunnerSheet({
  target,
  onOpenChange,
  onRemoved,
}: {
  target: { runner: RunnerInstance; poolName: string } | null;
  onOpenChange: (open: boolean) => void;
  onRemoved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const mutation = useMutation({
    mutationFn: () => removeRunnerInstance(target!.runner.runnerId),
    onSuccess: () => {
      toast.success(t("runners.removed"));
      onRemoved();
    },
  });

  if (!target) return null;
  const { runner, poolName } = target;
  return <ProtectedDeleteSheet
    open
    onOpenChange={onOpenChange}
    entityName={runner.runnerId}
    loading={false}
    ready={runner.status === "offline"}
    requiresConfirmation={false}
    deleting={mutation.isPending}
    error={mutation.error instanceof Error ? mutation.error : null}
    onRetry={() => mutation.reset()}
    onConfirm={() => mutation.mutate()}
    impactItems={[
      { label: t("runners.currentState"), value: t("runners.offline") },
      { label: t("runners.columns.lastHeartbeat"), value: formatDate(runner.lastHeartbeatAt, i18n.language) },
    ]}
    copy={{
      eyebrow: `${poolName} / ${runner.runnerId}`,
      title: t("runners.removal.title"),
      description: t("runners.removal.description"),
      protectedMessage: t("runners.removal.protectedMessage"),
      clearMessage: t("runners.removal.clearMessage"),
      retentionNote: t("runners.removal.retentionNote"),
      continueLabel: t("runners.removal.continue"),
      deleteLabel: t("runners.removal.delete"),
      deletingLabel: t("runners.removal.deleting"),
      confirmTitle: t("runners.removal.confirmTitle"),
      confirmDescription: runner.runnerId,
      confirmWarning: t("runners.removal.warning"),
      typeNameLabel: t("runners.removal.typeId"),
      protectedDeleteLabel: t("runners.removal.confirm"),
      cancelLabel: t("common.cancel"),
      backLabel: t("common.back"),
      retryLabel: t("common.retry"),
    }}
  />;
}

function RunnerPoolSheet({ pool, onOpenChange, onSaved }: { pool: RunnerPool | null; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [desired, setDesired] = useState(1);
  const [safeRps, setSafeRps] = useState(50);
  const [concurrency, setConcurrency] = useState(64);

  useEffect(() => {
    if (!pool) return;
    setDesired(pool.desiredReplicas);
    setSafeRps(pool.safeRpsPerRunner);
    setConcurrency(pool.maxConcurrencyPerRunner);
  }, [pool]);

  const mutation = useMutation({
    mutationFn: () => updateRunnerPool(pool!.id, {
      desiredReplicas: desired,
      safeRpsPerRunner: safeRps,
      maxConcurrencyPerRunner: concurrency,
    }),
    onSuccess: () => {
      toast.success(t("runners.settingsSaved"));
      onSaved();
    },
    onError: (error) => toast.error(error.message),
  });

  if (!pool) return null;
  const minimumDesired = pool?.isDefault ? 2 : 1;
  const valid = Number.isInteger(desired) && desired >= minimumDesired
    && Number.isFinite(safeRps) && safeRps > 0
    && Number.isInteger(concurrency) && concurrency >= 1;
  return (
    <EntitySheet
      open
      onOpenChange={onOpenChange}
      eyebrow={pool.id}
      title={t("runners.settingsTitle")}
      description={t("runners.settingsDescription")}
      footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button><Button disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>{t("common.save")}</Button></>}
    >
      <div className="grid gap-5">
        <NumberField label={t("runners.desiredReplicas")} value={desired} onChange={setDesired} min={minimumDesired} />
        <NumberField label={t("runners.safeRpsPerRunner")} value={safeRps} onChange={setSafeRps} min={0.1} />
        <NumberField label={t("runners.maxConcurrencyPerRunner")} value={concurrency} onChange={setConcurrency} min={1} />
      </div>
    </EntitySheet>
  );
}

function NumberField({ label, value, onChange, min }: { label: string; value: number; onChange: (value: number) => void; min: number }) {
  return <div className="grid gap-2"><Label>{label}</Label><Input type="number" min={min} value={value} onChange={(event) => onChange(Number(event.target.value))} /></div>;
}

function formatDate(value: string | null, locale: string) {
  return value ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}
