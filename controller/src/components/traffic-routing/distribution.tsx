import { Activity, AlertTriangle, CheckCircle2, GitBranch, RefreshCw } from 'lucide-react';
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '@/components/ui/table';
import './router-monitoring.scss';
import { revisionLabel } from "./router-view-model";
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { getRouterDistribution, getRouterRevisions, type TrafficRouter, type DistributionReport, type RouterDraft, type DistributionRow } from '@/lib/traffic-routing-api';
import { listControllerGuardrails } from '@/lib/controller-api';
import { EntitySheet } from '@/components/entity-sheet';
import { EmptyState, ErrorNotice } from '@/components/product-shell';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Field, NativeSelect, share, percent } from './form';
export function DistributionOverview({ router, endpoints }: { router: TrafficRouter; endpoints: Array<{ id: string; name: string }> }) {
  const { t: localize } = useTranslation();
  const { t } = useTranslation();
  const { t: translate } = useTranslation();
  const [hours, setHours] = useState(24);
  const [revision, setRevision] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [routeId, setRouteId] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['traffic-routers', router.id, 'distribution', hours, revision, endpoint], queryFn: () => getRouterDistribution(router.id, hours, revision ? Number(revision) : undefined, endpoint || undefined), refetchInterval: 30000 });
  const history = useQuery({ queryKey: ['traffic-routers', router.id, 'revisions'], queryFn: () => getRouterRevisions(router.id) });
  const guardrails = useQuery({ queryKey: ['routing-guardrails'], queryFn: listControllerGuardrails });
  const name = (id: string) => guardrails.data?.items.find(g => g.id === id)?.name ?? id;
  const report = query.data;
  const snapshots = report?.revisions ?? history.data?.items ?? [];
  const observedRevision = [...new Set(report?.rows.map(row => row.routerRevision).filter(Boolean))];
  const snapshot = revision ? snapshots.find(r => r.revision === Number(revision))?.snapshot : observedRevision.length === 1 ? snapshots.find(r => r.revision === observedRevision[0])?.snapshot : router.activeSnapshot;
  const routeIds = [...new Set([...(snapshot?.routes.map(r => r.id) ?? []), ...(report?.rows.flatMap(r => r.routeId ? [r.routeId] : []) ?? [])])];
  const routeName = (id: string) => snapshot?.routes.find(r => r.id === id)?.name ?? history.data?.items.flatMap(r => r.snapshot.routes).find(r => r.id === id)?.name ?? id;
  const fallbackIds = new Set([...(snapshot?.routes.filter(r => r.kind === 'fallback').map(r => r.id) ?? []), ...(history.data?.items.flatMap(r => r.snapshot.routes.filter(route => route.kind === 'fallback').map(route => route.id)) ?? [])]);
  const fallback = report?.rows.filter(r => r.routeId !== null && fallbackIds.has(r.routeId)).reduce((n, r) => n + r.count, 0) ?? 0;
  const assigned = report?.assigned ?? report?.rows.filter(isAssigned).reduce((n, r) => n + r.count, 0) ?? 0;
  const errors = report?.rows.filter(isAssigned).reduce((n, r) => n + r.errors, 0) ?? 0;
  const completed = report?.rows.filter(isAssigned).reduce((n, r) => n + r.completed, 0) ?? 0;
  const metrics = [
    { label: t("routing.totalCalls"), value: report?.total.toLocaleString(), detail: t("routing.firstRoutingDecisions"), tone: '' },
    { label: t("routing.assigned"), value: assigned.toLocaleString(), detail: t("routing.targetSelected"), tone: '' },
    { label: t("routing.unassigned"), value: report?.unassigned?.toLocaleString() ?? '—', detail: t("routing.noTargetSelected"), tone: (report?.unassigned ?? 0) > 0 ? 'warning' : '' },
    { label: localize("routing.fallback"), value: share(fallback, report?.total ?? 0), detail: translate('routerMonitoring.callCount', { count: fallback }), tone: '' },
    { label: t("routing.executionErrorRate"), value: share(errors, completed), detail: translate('routerMonitoring.errorCount', { errors: errors.toLocaleString(), completed: completed.toLocaleString() }), tone: errors > 0 ? 'error' : '', errors: true },
  ];
  const maxTrend = Math.max(...(report?.trend?.map(point => point.count) ?? []), 1);
  return <div className="router-monitoring">
    <section className="monitoring-query" aria-label={t("routing.monitoringFilters")}>
      <div className="monitoring-toolbar">
        <Field label={t("routing.timeWindow")}><NativeSelect value={hours} onChange={e => setHours(Number(e.target.value))}>{[[0.25, '15m'], [1, '1h'], [24, '24h'], [168, '7d']].map(([v, label]) => <option key={v} value={v}>{label}</option>)}</NativeSelect></Field>
        <Field label={t("routing.revision")}><NativeSelect value={revision} onChange={e => setRevision(e.target.value)}><option value="">{t("routing.allRevisions")}</option>{history.data?.items.map(r => <option key={r.revision} value={r.revision}>{revisionLabel(r)}</option>)}</NativeSelect></Field>
        <Field label={localize("routing.endpoint")}><NativeSelect value={endpoint} onChange={e => setEndpoint(e.target.value)}><option value="">{t("routing.allEndpoints")}</option>{endpoints.filter(e => router.endpointIds.includes(e.id)).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</NativeSelect></Field>
        <Button variant="ghost" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw aria-hidden="true" />{t("routing.refresh")}</Button>
      </div>
      {report && <div className="monitoring-freshness">
        <span className={report.telemetryFresh ? 'monitoring-current' : 'monitoring-delayed'}>{report.telemetryFresh ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}{report.telemetryFresh ? t("routing.telemetryCurrent") : t("routing.telemetryDelayed")}</span>
        <span>{t("routing.dataWatermark")}: {report.dataWatermark ? new Date(report.dataWatermark).toLocaleString() : t("routing.noData")} · {report.completeness}</span>
      </div>}
    </section>
    {history.error && <ErrorNotice error={history.error} />}
    {query.isPending && <Skeleton className="h-44" />}
    {query.error && <div className="monitoring-panel p-5 space-y-3"><ErrorNotice error={query.error} /><Button variant="outline" onClick={() => void query.refetch()}>{t("routing.retryMetrics")}</Button></div>}
    {report && <>
      {!report.telemetryFresh && <p role="alert" className="monitoring-notice monitoring-notice-warning"><AlertTriangle aria-hidden="true" />{t("routing.telemetryIsDelayedOrUnavailableCountsMayBeIncomplete")}</p>}
      {report.multipleRevisions && <p role="status" className="monitoring-notice"><GitBranch aria-hidden="true" />{t("routing.thisWindowContainsMultipleRevisionsSelectARevisionTo")}</p>}
      <dl className="monitoring-metrics">{metrics.map(metric => <div key={metric.label} data-tone={metric.tone}>
        <dt>{metric.label}</dt><dd>{metric.value}</dd><dd className="monitoring-metric-detail">{metric.detail}</dd>{metric.errors && errors > 0 ? <dd><Link to="/logs" search={{ outcome: "error", routerId: router.id, routerRevision: revision ? Number(revision) : undefined, endpointId: endpoint || undefined, since: report.since, until: report.until }} className="text-sm text-primary underline underline-offset-4">{t("logs.viewErrors")}</Link></dd> : null}
      </div>)}</dl>
      <section className="monitoring-panel" aria-label={t("routing.routeDistribution")}>
        <header className="monitoring-panel-heading"><div><h3><GitBranch aria-hidden="true" />{t("routing.routeDistribution")}</h3><p>{t("routing.routeShareUsesAllRouterCallsTargetSharesUse")}</p></div></header>
        {!report.total && report.telemetryFresh ? <div className="monitoring-empty"><EmptyState title={t("routing.noTrafficYet")} description={t("routing.actualDistributionAppearsAfterNewLogicalCallsDraftWeights")} /></div> : !routeIds.length ? <div className="monitoring-empty"><EmptyState title={t("routing.noRouteAssignmentsAvailable")} description={t("routing.unassignedCallsAreIncludedInTheSummaryAndAre")} /></div> : <Table className="monitoring-route-table" aria-label={t("routing.routeDistribution")}><TableHeader><TableRow>
          {[localize("routing.route"), t("routing.calls"), t("routing.routerShare"), t("routing.actualTargetDistribution")].map(label => <TableHead key={label}>{label}</TableHead>)}
        </TableRow></TableHeader><TableBody>{routeIds.map(id => {
          const rows = report.rows.filter(r => r.routeId === id), count = rows.reduce((n, r) => n + r.count, 0);
          const assignedRows = rows.filter(isAssigned);
          const routeAssigned = assignedRows.reduce((n, row) => n + row.count, 0);
          const targets = [...new Set(assignedRows.map(r => `${r.guardrailId}@${r.guardrailVersion}`))];
          return <TableRow key={id}>
            <TableCell><button type="button" className="monitoring-link" onClick={() => setRouteId(id)}>{routeName(id)}</button></TableCell>
            <TableCell><button type="button" className="monitoring-link tabular-nums" onClick={() => setRouteId(id)}>{count.toLocaleString()}</button></TableCell>
            <TableCell className="tabular-nums">{share(count, report.total)}</TableCell>
            <TableCell><button type="button" className="monitoring-targets" onClick={() => setRouteId(id)} aria-label={translate('routerMonitoring.viewTargets', { name: routeName(id) })}>{targets.map(target => {
              const matching = assignedRows.filter(r => `${r.guardrailId}@${r.guardrailVersion}` === target);
              return <span key={target} className="monitoring-target"><span>{name(matching[0]!.guardrailId)}<code>{matching[0]!.guardrailVersion}</code></span><span>{share(matching.reduce((n, r) => n + r.count, 0), routeAssigned)}</span></span>;
            })}{!targets.length && t("routing.viewTargets")}</button></TableCell>
          </TableRow>;
        })}</TableBody></Table>}
      </section>
      <section className="monitoring-panel" aria-label={t("routing.callsByRouteOverTime")}>
        <header className="monitoring-panel-heading"><h3><Activity aria-hidden="true" />{t("routing.callsByRouteOverTime")}</h3></header>
        {report.trend?.length ? <div className="monitoring-trend">{report.trend.map((point, index) => <div key={index} className="monitoring-trend-row"><span><time dateTime={point.at}>{new Date(point.at).toLocaleString()}</time><span>{point.routeId ? routeName(point.routeId) : t("routing.unassigned")}</span></span><meter aria-label={`${point.at} · ${point.routeId ? routeName(point.routeId) : t("routing.unassigned")}`} min={0} max={maxTrend} value={point.count} /><span>{point.count.toLocaleString()}</span></div>)}</div> : <p className="monitoring-trend-empty">{t("routing.trendDataUnavailable")}</p>}
      </section>
    </>}
    {routeId && report && <TargetDistribution routerId={router.id} routeId={routeId} routeName={routeName(routeId)} report={report} snapshot={snapshot ?? null} name={name} revisionName={n => revisionLabel(history.data?.items.find(r => r.revision === n))} close={() => setRouteId(null)} />}
  </div>;
}

function TargetDistribution({ routerId, routeId, routeName, report, snapshot, name, revisionName, close }: { routerId: string; routeId: string; routeName: string; report: DistributionReport; snapshot: RouterDraft | null; name: (id: string) => string; revisionName: (revision: number) => string; close: () => void }) {
  const { t: localize } = useTranslation();
  const { t } = useTranslation();
  const rows = report.rows.filter(isAssigned).filter(r => r.routeId === routeId);
  const count = rows.reduce((n, r) => n + r.count, 0);
  return <EntitySheet open onOpenChange={open => { if (!open) close(); }} width="xl" eyebrow={localize("routing.distribution")} title={routeName} description={t("routing.actualShareUsesThisRouteSAssignmentsOutcomesUse")} footer={<Button onClick={close}>{t("routing.close")}</Button>}><div className="space-y-4">{!rows.length && <p>{t("routing.noTargetAssignmentsInThisWindow")}</p>}{rows.map(row => {
    const configured = !report.multipleRevisions ? snapshot?.routes.find(r => r.id === routeId)?.targets.find(target => target.id === row.targetId && target.guardrailId === row.guardrailId && target.guardrailVersion === row.guardrailVersion)?.weightBps : undefined;
    return <article key={`${row.routerRevision}:${row.targetId}`} className="monitoring-target-detail"><h3 className="font-semibold">{name(row.guardrailId)} · {row.guardrailVersion} <span className="text-sm font-normal">{revisionName(row.routerRevision)}</span></h3><dl className="monitoring-target-metrics">{[[t("routing.configured"), configured === undefined ? '—' : percent(configured)], [t("routing.actual"), share(row.count, count)], [t("routing.assignments"), row.count], ['allow / block', `${row.allowed} / ${row.blocked}`], ['transform / intervene', `${row.transformed} / ${row.intervened}`], [t("routing.errorRate"), share(row.errors, row.completed)], [t("routing.completedAssigned"), `${row.completed} / ${row.count}`], [t("routing.inferredCompletionsTimeout"), row.inferredCompletions], [t("routing.endToEndP95IncludesWaiting"), row.p95Ms === null ? '—' : `${Number(row.p95Ms).toFixed(1)} ms`]].map(([label, value]) => <div key={String(label)}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 tabular-nums">{value}</dd></div>)}</dl><Button asChild className="min-h-11" variant="outline"><Link to="/logs" search={{ routerId, routeId, targetId: row.targetId, routerRevision: row.routerRevision, since: report.since, until: report.until }}>{t("routing.viewCallLogs")}</Link></Button></article>;
  })}</div></EntitySheet>;
}

export function isAssigned(row: DistributionRow): row is DistributionRow & { routeId: string; targetId: string; routerRevision: number; guardrailId: string; guardrailVersion: string } {
  return row.assignmentStatus === 'assigned' && Boolean(row.routeId && row.targetId && row.routerRevision && row.guardrailId && row.guardrailVersion);
}
