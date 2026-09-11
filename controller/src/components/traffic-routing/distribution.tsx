import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { getRouterDistribution, getRouterRevisions, type TrafficRouter, type DistributionReport, type RouterDraft, type DistributionRow } from '@/lib/traffic-routing-api';
import { listControllerGuardrails } from '@/lib/controller-api';
import { EntitySheet } from '@/components/entity-sheet';
import { EmptyState, ErrorNotice } from '@/components/product-shell';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Field, NativeSelect, share, percent, useRoutingText } from './form';
export function DistributionOverview({ router, endpoints }: { router: TrafficRouter; endpoints: Array<{ id: string; name: string }> }) {
  const t = useRoutingText();
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
  return <div className="space-y-5">
    <div className="grid gap-3 sm:grid-cols-3"><Field label={t('时间窗口', 'Time window')}><NativeSelect value={hours} onChange={e => setHours(Number(e.target.value))}>{[[0.25, '15m'], [1, '1h'], [24, '24h'], [168, '7d']].map(([v, label]) => <option key={v} value={v}>{label}</option>)}</NativeSelect></Field><Field label="Revision"><NativeSelect value={revision} onChange={e => setRevision(e.target.value)}><option value="">{t('全部版本', 'All revisions')}</option>{history.data?.items.map(r => <option key={r.revision} value={r.revision}>r{r.revision}</option>)}</NativeSelect></Field><Field label="Endpoint"><NativeSelect value={endpoint} onChange={e => setEndpoint(e.target.value)}><option value="">{t('全部接入', 'All Endpoints')}</option>{endpoints.filter(e => router.endpointIds.includes(e.id)).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</NativeSelect></Field></div>
    {query.isPending && <Skeleton className="h-44" />}{query.error && <><ErrorNotice error={query.error} /><Button onClick={() => void query.refetch()}>{t('重试统计', 'Retry metrics')}</Button></>}
    {report && <><p className="text-xs text-muted-foreground">{t('统计单位：逻辑调用首次路由决策', 'Unit: first routing decision per logical call')} · {t('数据水位', 'Data watermark')}: {report.dataWatermark ? new Date(report.dataWatermark).toLocaleString() : t('尚无数据', 'No data')} {report.completeness}</p>{report.multipleRevisions && <p role="status" className="rounded-md border p-3 text-sm">{t('窗口包含多个配置版本；请选择 revision 后比较配置占比。', 'This window contains multiple revisions. Select a revision to compare configured shares.')}</p>}
    <dl className="grid grid-cols-2 divide-x rounded-md border bg-card lg:grid-cols-5">{[[t('总调用', 'Total calls'), report.total.toLocaleString()], [t('已分配', 'Assigned'), assigned.toLocaleString()], [t('未分配', 'Unassigned'), report.unassigned === undefined ? '—' : report.unassigned.toLocaleString()], ['Fallback', share(fallback, report.total)], [t('执行错误 / 已完成', 'Errors / completed'), share(errors, completed)]].map(([label, value]) => <div key={label} className="p-4"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-2 text-xl font-semibold tabular-nums">{value}</dd></div>)}</dl>
    {!report.telemetryFresh && <p role="alert">{t('遥测延迟或不可用；数字可能不完整。', 'Telemetry is delayed or unavailable; counts may be incomplete.')}</p>}{!report.total && report.telemetryFresh && <EmptyState title={t('暂无流量', 'No traffic yet')} description={t('有新逻辑调用后显示实际分布。草稿权重不会替代运行数据。', 'Actual distribution appears after new logical calls. Draft weights never replace runtime data.')} />}
    <div className="overflow-auto rounded-md border"><table className="w-full text-left text-sm"><thead className="border-b bg-muted/25"><tr>{['Route', t('调用量', 'Calls'), t('占 Router 流量', 'Router share'), t('目标实际分布', 'Actual target distribution')].map(label => <th key={label} className="p-4">{label}</th>)}</tr></thead><tbody>{routeIds.map(id => {
      const rows = report.rows.filter(r => r.routeId === id), count = rows.reduce((n, r) => n + r.count, 0);
      const assignedRows = rows.filter(isAssigned);
      const routeAssigned = assignedRows.reduce((n, row) => n + row.count, 0);
      const targets = [...new Set(assignedRows.map(r => `${r.guardrailId}@${r.guardrailVersion}`))];
      return <tr key={id} className="border-b last:border-0"><td className="p-4 font-medium">{routeName(id)}</td><td className="p-4"><button className="min-h-11 text-primary underline" onClick={() => setRouteId(id)}>{count.toLocaleString()}</button></td><td className="p-4">{share(count, report.total)}</td><td className="p-4"><button className="min-h-11 text-left text-primary" onClick={() => setRouteId(id)}>{targets.map(target => { const matching = assignedRows.filter(r => `${r.guardrailId}@${r.guardrailVersion}` === target); return `${name(matching[0]!.guardrailId)} ${matching[0]!.guardrailVersion} ${share(matching.reduce((n, r) => n + r.count, 0), routeAssigned)}`; }).join(' / ') || t('查看目标', 'View targets')}</button></td></tr>;
    })}</tbody></table></div>
    {report.trend?.length ? <section className="space-y-2"><h3 className="font-semibold">{t('Route 调用趋势', 'Calls by Route over time')}</h3>{report.trend.map((point, index) => <div key={index} className="grid grid-cols-[10rem_minmax(0,1fr)_4rem] items-center gap-3 text-xs"><span>{new Date(point.at).toLocaleTimeString()} · {point.routeId ? routeName(point.routeId) : t('未分配', 'Unassigned')}</span><meter className="h-4 w-full" min={0} max={Math.max(...report.trend!.map(p => p.count), 1)} value={point.count} /><span>{point.count}</span></div>)}</section> : <p className="text-xs text-muted-foreground">{t('趋势数据暂不可用', 'Trend data unavailable')}</p>}
    </>}
    {routeId && report && <TargetDistribution routerId={router.id} routeId={routeId} routeName={routeName(routeId)} report={report} snapshot={snapshot ?? null} name={name} close={() => setRouteId(null)} />}
  </div>;
}
function TargetDistribution({ routerId, routeId, routeName, report, snapshot, name, close }: { routerId: string; routeId: string; routeName: string; report: DistributionReport; snapshot: RouterDraft | null; name: (id: string) => string; close: () => void }) {
  const t = useRoutingText();
  const rows = report.rows.filter(isAssigned).filter(r => r.routeId === routeId);
  const count = rows.reduce((n, r) => n + r.count, 0);
  return <EntitySheet open onOpenChange={open => { if (!open) close(); }} width="xl" eyebrow="Distribution" title={routeName} description={t('实际占比以此 Route 的已分配量为分母；执行结果以已完成量为分母。', 'Actual share uses this Route’s assignments; outcomes use completed calls.')} footer={<Button onClick={close}>{t('关闭', 'Close')}</Button>}><div className="space-y-4">{!rows.length && <p>{t('此窗口暂无目标分配。', 'No target assignments in this window.')}</p>}{rows.map(row => {
    const configured = !report.multipleRevisions ? snapshot?.routes.find(r => r.id === routeId)?.targets.find(target => target.id === row.targetId && target.guardrailId === row.guardrailId && target.guardrailVersion === row.guardrailVersion)?.weightBps : undefined;
    return <article key={`${row.routerRevision}:${row.targetId}`} className="space-y-3 rounded-md border p-4"><h3 className="font-semibold">{name(row.guardrailId)} · {row.guardrailVersion} <span className="text-sm font-normal">r{row.routerRevision}</span></h3><dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">{[[t('配置占比', 'Configured'), configured === undefined ? '—' : percent(configured)], [t('实际占比', 'Actual'), share(row.count, count)], [t('分配量', 'Assignments'), row.count], ['allow / block', `${row.allowed} / ${row.blocked}`], ['transform / intervene', `${row.transformed} / ${row.intervened}`], [t('执行错误率', 'Error rate'), share(row.errors, row.completed)], [t('已完成 / 分配', 'Completed / assigned'), `${row.completed} / ${row.count}`], [t('推断完成（超时）', 'Inferred completions (timeout)'), row.inferredCompletions], [t('端到端 p95（包含等待）', 'End-to-end p95 (includes waiting)'), row.p95Ms === null ? '—' : `${Number(row.p95Ms).toFixed(1)} ms`]].map(([label, value]) => <div key={String(label)}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 tabular-nums">{value}</dd></div>)}</dl><Button asChild className="min-h-11" variant="outline"><Link to="/logs" search={{ routerId, routeId, targetId: row.targetId, routerRevision: row.routerRevision, since: report.since, until: report.until }}>{t('查看调用日志', 'View call logs')}</Link></Button></article>;
  })}</div></EntitySheet>;
}

export function isAssigned(row: DistributionRow): row is DistributionRow & { routeId: string; targetId: string; routerRevision: number; guardrailId: string; guardrailVersion: string } {
  return row.assignmentStatus === 'assigned' && Boolean(row.routeId && row.targetId && row.routerRevision && row.guardrailId && row.guardrailVersion);
}
