import { Fragment, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/notifications";

import { EmptyState, ErrorNotice, StateBadge } from "@/components/product-shell";
import { ProtectedDeleteSheet } from "@/components/protected-delete-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { listRunnerPools, removeRunnerInstance, updateRunnerPool, type RunnerInstance, type RunnerPool } from "@/lib/controller-api";
import "./runner-capacity.scss";

export const runnerPoolKey = ["resources", "runner-pools"] as const;
type RemovalTarget = { runner: RunnerInstance; poolName: string };

export function RunnerCapacitySection({ showHeader = true }: { showHeader?: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: runnerPoolKey, queryFn: ({ signal }) => listRunnerPools(signal), refetchInterval: 10_000, retry: false });
  const [removing, setRemoving] = useState<RemovalTarget | null>(null);
  return (
    <section className="runner-capacity" aria-labelledby={showHeader ? "runner-capacity-title" : undefined} aria-label={showHeader ? undefined : t("runners.title")}>
      {showHeader ? <header><h2 id="runner-capacity-title" className="text-base font-semibold">{t("runners.title")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("runnerView.description")}</p></header> : null}
      {query.isLoading ? <div className="runner-pool-panel" aria-busy="true"><p role="status">{t("runnerView.loading")}</p><Skeleton className="mt-5 h-64" /></div> : null}
      {query.isError ? <div className="runner-pool-panel"><h2 className="runner-summary-title">{t("runnerView.unavailable")}</h2><p className="mt-2 mb-4 text-sm text-muted-foreground">{t("runnerView.unavailableDetail")}</p><ErrorNotice error={query.error} /><Button variant="outline" className="mt-4 min-h-11" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw />{t(query.isFetching ? "runnerView.refreshing" : "common.retry")}</Button></div> : null}
      {!query.isLoading && !query.isError && !query.data?.items.length ? <EmptyState title={t("runners.emptyTitle")} description={t("runners.emptyDescription")} /> : null}
      {!query.isError && query.data?.items.map(pool => <RunnerPoolPanel key={pool.id} pool={pool} updatedAt={query.dataUpdatedAt} refreshing={query.isFetching} onRemove={setRemoving} />)}
      <RemoveRunnerSheet key={removing?.runner.runnerId ?? "closed"} target={removing} onOpenChange={open => { if (!open) setRemoving(null); }} onRemoved={async () => { setRemoving(null); await queryClient.invalidateQueries({ queryKey: runnerPoolKey }); }} />
    </section>
  );
}

function RunnerPoolPanel({ pool, updatedAt, refreshing, onRemove }: { pool: RunnerPool; updatedAt: number; refreshing: boolean; onRemove: (target: RemovalTarget) => void }) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const id = useId();
  const [planning, setPlanning] = useState(false);
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const connected = pool.instances.filter(runner => runner.status !== "offline");
  const pending = connected.filter(runner => runner.appliedGeneration !== runner.desiredGeneration);
  const syncing = connected.filter(runner => runner.status === "syncing");
  const offline = pool.instances.length - connected.length;
  const serving = pool.capacity.readyRunners;
  const titleKey = !pool.instances.length ? "noRegistered" : serving > 0 ? "serving" : syncing.length > 0 ? "updating" : "noneServing";
  const summary = !pool.instances.length ? t("runnerView.waitingRegistration") : [
    offline ? t("runnerView.offlineSummary", { count: offline }) : "",
    pending.length ? t("runnerView.pendingSummary", { count: pending.length }) : connected.length ? t("runnerView.allApplied") : "",
  ].filter(Boolean).join(" ");
  const hasMetrics = pool.instances.some(runner => ["ready", "busy", "saturated"].includes(runner.status) && runner.load !== null);
  const metric = (value: string) => hasMetrics ? value : "—";
  return (
    <article className="runner-pool-panel" aria-label={t("runnerView.groupLabel", { name: pool.name })}>
      <div className="runner-pool-heading"><span>{t("runnerView.group")}</span><strong>{pool.name}</strong>{pool.isDefault ? <span>· {t("runnerView.defaultGroup")}</span> : null}</div>
      <div className="runner-summary">
        <div aria-live="polite"><h2 className="runner-summary-title" data-tone={!pool.instances.length ? "neutral" : serving > 0 ? "neutral" : syncing.length > 0 ? "warning" : "danger"}>{t(`runnerView.${titleKey}`, { count: titleKey === "updating" ? syncing.length : serving })}</h2><p>{summary}</p></div>
        <div className="runner-updated"><span>{t("runnerView.lastUpdated")}</span><time dateTime={new Date(updatedAt).toISOString()}>{new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(updatedAt)}</time><span>{t("runnerView.updates")}</span></div>
      </div>
      <dl className="runner-live-metrics" aria-label={t("runners.liveMetrics")}>
        <RunnerMetric label={t("runners.currentThroughput")} value={metric(`${pool.capacity.currentRps.toFixed(1)} RPS`)} />
        <RunnerMetric label={t("runners.inflightUtilization")} value={metric(`${Math.round(pool.capacity.inflightUtilization * 100)}%`)} />
        <RunnerMetric label={t("runnerView.highestP95")} value={metric(`${Math.round(pool.capacity.worstRunnerLatencyP95Ms ?? pool.capacity.latencyP95Ms)} ms`)} />
        <RunnerMetric label={t("runners.errorRate")} value={metric(`${(pool.capacity.errorRate * 100).toFixed(2)}%`)} />
      </dl>
      <section aria-labelledby={`${id}-instances`}>
        <header className="runner-instance-heading"><h3 id={`${id}-instances`}>{t("runners.instancesTitle")}</h3><span>{t("runnerView.registered", { count: pool.instances.length })}</span></header>
        <Table className="runner-instance-table table-fixed" aria-labelledby={`${id}-instances`}>
          <TableHeader><TableRow><TableHead className="w-[29%]">{t("runnerView.instance")}</TableHead><TableHead className="w-[14%]">{t("runnerView.runtime")}</TableHead><TableHead className="w-[23%]">{t("runnerView.configuration")}</TableHead><TableHead className="w-[16%]">{t("runners.columns.inflightQueue")}</TableHead><TableHead className="w-[18%]">{t("runners.columns.lastHeartbeat")}</TableHead></TableRow></TableHeader>
          <TableBody>{pool.instances.map(runner => <RunnerRow key={runner.runnerId} runner={runner} now={updatedAt} canRemove={user?.role === "admin"} onRemove={() => onRemove({ runner, poolName: pool.name })} />)}
            {!pool.instances.length ? <TableRow><TableCell colSpan={5} className="runner-empty-row">{t("runnerView.waitingRegistration")}</TableCell></TableRow> : null}
          </TableBody>
        </Table>
      </section>
      <div className="runner-planning-line"><p><strong>{t("runnerView.capacityTarget", { count: pool.desiredReplicas })}</strong><span> · {t("runnerView.currentlyServing", { count: serving })}</span></p><Button variant="link" className="min-h-11 shrink-0" aria-expanded={planning} aria-controls={`${id}-planning`} onClick={() => { setPlanning(!planning); if (planning) setEditing(false); }}>{t("runners.planningTitle")}<ChevronDown className={planning ? "rotate-180" : undefined} /></Button></div>
      <section className="runner-planning" id={`${id}-planning`} hidden={!planning} aria-labelledby={`${id}-planning-title`}>
        <h3 id={`${id}-planning-title`}>{t("runners.planningTitle")}</h3>
        <dl className="runner-planning-facts"><RunnerDatum label={t("runnerView.servingLabel")} value={String(serving)} /><RunnerDatum label={t("runnerView.desiredLabel")} value={String(pool.desiredReplicas)} /><RunnerDatum label={t("runnerView.recommendedLabel")} value={String(pool.capacity.recommendedReplicas)} /></dl>
        <p>{t("runnerView.plannedCapacity", { capacity: pool.capacity.safeRpsCapacity.toFixed(1), count: serving, perRunner: pool.safeRpsPerRunner.toFixed(1) })}</p>
        <p>{t("runnerView.planningHint")}</p>
        {user?.role === "admin" ? <Button ref={editButton} variant="link" className="mt-2 min-h-11" aria-expanded={editing} aria-controls={`${id}-editor`} onClick={() => setEditing(!editing)}>{t("runnerView.editTargets")}</Button> : null}
        {editing ? <div id={`${id}-editor`}><RunnerCapacityEditor pool={pool} onClose={() => { setEditing(false); editButton.current?.focus(); }} /></div> : null}
      </section>
      <p className="runner-feedback" role="status">{t(refreshing ? "runnerView.refreshingPrevious" : "runnerView.complete")}</p>
    </article>
  );
}

function RunnerRow({ runner, now, canRemove, onRemove }: { runner: RunnerInstance; now: number; canRemove: boolean; onRemove: () => void }) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const offline = runner.status === "offline";
  const current = runner.appliedGeneration === runner.desiredGeneration;
  const configuration = offline ? "unavailable" : current ? "applied" : "pending";
  const load = offline ? null : runner.load;
  const removable = canRemove && (offline || runner.status === "syncing");
  return <Fragment>
    <TableRow className="runner-instance-row" data-runner-state={runner.status}>
      <TableCell><Button variant="link" className="runner-instance-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}><ChevronRight className={expanded ? "rotate-90" : undefined} /><span>{runner.runnerId}</span></Button></TableCell>
      <TableCell><span className="runner-runtime-state" data-runner-state={runner.status}>{t(`runnerView.runtimeState.${runner.status}`)}</span></TableCell>
      <TableCell><p className="runner-configuration-state" data-configuration={configuration}>{t(`runnerView.configurationState.${configuration}`)}</p><p className="runner-cell-detail">{t(offline ? "runnerView.lastApplied" : current ? "runnerView.appliedVersion" : "runnerView.versionDifference", { applied: runner.appliedGeneration, desired: runner.desiredGeneration })}</p></TableCell>
      <TableCell>{load ? `${load.inflight} / ${load.queueDepth}` : "—"}</TableCell>
      <TableCell><time dateTime={validDate(runner.lastHeartbeatAt)?.toISOString()} title={formatDate(runner.lastHeartbeatAt, i18n.language)}>{relativeHeartbeat(runner.lastHeartbeatAt, now, i18n.language)}</time></TableCell>
    </TableRow>
    {expanded ? <TableRow className="runner-detail-row" id={id}><TableCell colSpan={5}>
      <div className="runner-instance-details">
        <dl><RunnerDatum label={t("runnerView.runtimeVersion")} value={runner.runnerVersion || "—"} /><RunnerDatum label={t("runnerView.nemoVersion")} value={runner.nemoVersion || "—"} /><RunnerDatum label={t("runnerView.compiler")} value={t(runner.compilerCapable ? "runnerView.enabled" : "runnerView.disabled")} /></dl>
        <dl><RunnerDatum label={t("uiCopy.cPUMemory")} value={load ? `${Math.round(load.cpuUtilization * 100)}% / ${Math.round(load.memoryUtilization * 100)}%` : "—"} /><RunnerDatum label={t("runners.maxConcurrencyPerRunner")} value={String(runner.maxConcurrency)} /><RunnerDatum label={t("runnerView.heartbeatReported")} value={formatDate(runner.lastHeartbeatAt, i18n.language)} /></dl>
        <div><dl><RunnerDatum label={t(offline ? "runnerView.lastVersions" : "runnerView.appliedCurrent")} value={`${runner.appliedGeneration} / ${runner.desiredGeneration}`} /></dl><p>{t(`runnerView.configurationDetail.${configuration}`)}</p>{removable ? <Button type="button" variant="ghost" className="runner-remove-button mt-3 min-h-11" aria-label={t(offline ? "runners.removeAria" : "runners.forceRemoveAria", { runnerId: runner.runnerId })} onClick={onRemove}><Trash2 />{t(offline ? "runners.removeOffline" : "runners.forceRemove")}</Button> : null}</div>
      </div>
    </TableCell></TableRow> : null}
  </Fragment>;
}

function RunnerMetric({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
function RunnerDatum({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
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
  const force = target?.runner.status === "syncing";
  const mutation = useMutation({
    mutationFn: () => force
      ? removeRunnerInstance(target!.runner.runnerId, { force: true, bootId: target!.runner.bootId })
      : removeRunnerInstance(target!.runner.runnerId),
    onSuccess: () => {
      toast.success(t(force ? "runners.forceRemoved" : "runners.removed"));
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
    ready={runner.status === "offline" || force}
    requiresConfirmation={false}
    deleting={mutation.isPending}
    error={mutation.error instanceof Error ? mutation.error : null}
    onRetry={() => mutation.reset()}
    onConfirm={() => mutation.mutate()}
    impactItems={[
      { label: t("runners.currentState"), value: <StateBadge state={runner.status} /> },
      { label: t("runners.columns.lastHeartbeat"), value: formatDate(runner.lastHeartbeatAt, i18n.language) },
    ]}
    copy={{
      eyebrow: `${poolName} / ${runner.runnerId}`,
      title: t(force ? "runners.removal.forceTitle" : "runners.removal.title"),
      description: t(force ? "runners.removal.forceDescription" : "runners.removal.description"),
      protectedMessage: t("runners.removal.protectedMessage"),
      clearMessage: t(force ? "runners.removal.forceWarning" : "runners.removal.clearMessage"),
      retentionNote: t("runners.removal.retentionNote"),
      continueLabel: t("runners.removal.continue"),
      deleteLabel: t(force ? "runners.forceRemove" : "runners.removal.delete"),
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

function RunnerCapacityEditor({ pool, onClose }: { pool: RunnerPool; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [desired, setDesired] = useState(pool.desiredReplicas);
  const [safeRps, setSafeRps] = useState(pool.safeRpsPerRunner);
  const [concurrency, setConcurrency] = useState(pool.maxConcurrencyPerRunner);
  const minimumDesired = pool.isDefault ? 2 : 1;
  const valid = Number.isInteger(desired) && desired >= minimumDesired && Number.isFinite(safeRps) && safeRps >= 0.1 && Number.isInteger(concurrency) && concurrency >= 1;
  const mutation = useMutation({
    mutationFn: () => updateRunnerPool(pool.id, { desiredReplicas: desired, safeRpsPerRunner: safeRps, maxConcurrencyPerRunner: concurrency }),
    onSuccess: async () => { toast.success(t("runners.settingsSaved")); onClose(); await queryClient.invalidateQueries({ queryKey: runnerPoolKey }); },
  });
  return <form className="runner-capacity-editor" onSubmit={event => { event.preventDefault(); if (valid && !mutation.isPending) mutation.mutate(); }}>
    <fieldset disabled={mutation.isPending} className="runner-capacity-fields">
      <NumberField label={t("runnerView.desiredLabel")} value={desired} onChange={setDesired} min={minimumDesired} step={1} />
      <NumberField label={t("runners.safeRpsPerRunner")} value={safeRps} onChange={setSafeRps} min={0.1} step="any" />
      <NumberField label={t("runners.maxConcurrencyPerRunner")} value={concurrency} onChange={setConcurrency} min={1} step={1} />
    </fieldset>
    {mutation.isError ? <ErrorNotice error={mutation.error} /> : null}
    <div className="runner-capacity-actions"><Button variant="ghost" disabled={mutation.isPending} onClick={onClose}>{t("common.cancel")}</Button><Button type="submit" disabled={!valid || mutation.isPending}>{t(mutation.isPending ? "runnerView.saving" : "runnerView.saveTargets")}</Button></div>
  </form>;
}

function NumberField({ label, value, onChange, min, step }: { label: string; value: number; onChange: (value: number) => void; min: number; step: number | "any" }) {
  const id = useId();
  return <div className="grid gap-2"><Label htmlFor={id}>{label}</Label><Input id={id} type="number" min={min} step={step} required value={Number.isNaN(value) ? "" : value} onChange={event => onChange(event.target.valueAsNumber)} /></div>;
}
function validDate(value: string | null) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}
function formatDate(value: string | null, locale: string) {
  const date = validDate(value);
  return date ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(date) : "—";
}
function relativeHeartbeat(value: string, now: number, locale: string) {
  const date = validDate(value);
  if (!date) return "—";
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  const [amount, unit] = seconds < 60 ? [seconds, "second"] as const : seconds < 3600 ? [Math.floor(seconds / 60), "minute"] as const : seconds < 86400 ? [Math.floor(seconds / 3600), "hour"] as const : [Math.floor(seconds / 86400), "day"] as const;
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-amount, unit);
}
