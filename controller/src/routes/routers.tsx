import { CreateRouterSheet } from '@/components/traffic-routing/create-router-sheet';
export { CreateRouterSheet } from '@/components/traffic-routing/create-router-sheet';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, MoreHorizontal, History, ArrowUpRight, GitBranch } from 'lucide-react';
import { EmptyState, ErrorNotice, PageHeader } from '@/components/product-shell';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { share, useRoutingText } from '@/components/traffic-routing/form';
import { useAuth } from '@/lib/auth';
import { getEndpoints } from '@/lib/api';
import { getRouterDistribution, listTrafficRouters, trafficRouterKeys, type TrafficRouter } from '@/lib/traffic-routing-api';

export function RoutersPage() {
  const t = useRoutingText();
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const routers = useQuery({ queryKey: trafficRouterKeys.all, queryFn: listTrafficRouters });
  const endpoints = useQuery({ queryKey: ['routing-endpoints'], queryFn: getEndpoints });
  return <section className="py-6 sm:py-8"><PageHeader title={t('流量 Routers', 'Traffic Routers')} description={t('按顺序选择流量，在每条 Route 内按比例分配给固定版本的 Guardrail。', 'Select traffic in Route order, then distribute each Route across pinned Guardrail versions.')} action={auth.user?.role === 'admin' ? <Button variant="create" className="min-h-11" onClick={() => setOpen(true)}><Plus />{t('创建 Router', 'Create Router')}</Button> : undefined} />
    {routers.isPending && <Skeleton className="mt-5 h-48" />}
    {routers.error && <div className="mt-5 space-y-3"><ErrorNotice error={routers.error} /><Button onClick={() => void routers.refetch()}>{t('重试', 'Retry')}</Button></div>}
    {routers.data && !routers.data.items.length && <div className="mt-5"><EmptyState title={t('尚无 Router', 'No Routers yet')} description={t('选择来源 Endpoint，配置路由规则和默认 Guardrail。', 'Choose source Endpoints, routing rules, and a default Guardrail.')} /></div>}
    {!!routers.data?.items.length && <div className="mt-5 overflow-x-auto rounded-md border bg-card"><table className="w-full text-left text-sm"><thead className="border-b bg-muted/30"><tr>{['Router', 'Endpoints', t('启用 Route', 'Enabled Routes'), t('24h 调用量', '24h calls'), 'Fallback', t('发布状态', 'Rollout'), t('操作', 'Actions')].map(label => <th key={label} className="p-4 font-medium">{label}</th>)}</tr></thead><tbody>{routers.data.items.map(router => <RouterRow key={router.id} router={router} endpointName={id => endpoints.data?.items.find(e => e.id === id)?.name ?? id} />)}</tbody></table></div>}
    {open && <CreateRouterSheet open onOpenChange={setOpen} onCreated={() => setOpen(false)} />}
  </section>;
}
function RouterRow({ router, endpointName }: { router: TrafficRouter; endpointName: (id: string) => string }) {
  const t = useRoutingText();
  const metrics = useQuery({ queryKey: [...trafficRouterKeys.detail(router.id), 'distribution', 24], queryFn: () => getRouterDistribution(router.id), retry: false });
  const fallbackIds = new Set(router.activeSnapshot?.routes.filter(r => r.kind === 'fallback').map(r => r.id));
  const fallback = metrics.data?.rows.filter(r => r.routeId !== null && fallbackIds.has(r.routeId)).reduce((n, r) => n + r.count, 0) ?? 0;
  return <tr className="border-b last:border-0"><td className="p-4"><Link className="inline-flex min-h-11 items-center gap-2 font-medium text-primary" to="/integration/routers/$routerId" params={{ routerId: router.id }}><GitBranch aria-hidden="true" className="size-4 shrink-0" /><span>{router.name}</span></Link><p className="max-w-xs text-xs text-muted-foreground">{router.description}</p></td><td className="p-4">{router.endpointIds.length ? router.endpointIds.map(endpointName).join(', ') : t('未接入', 'Unbound')}</td><td className="p-4 tabular-nums">{router.draft.routes.filter(r => r.kind === 'normal' && r.enabled).length} + 1 Fallback</td><td className="p-4 tabular-nums">{metrics.error ? t('数据暂不可用', 'Data unavailable') : metrics.data ? metrics.data.total.toLocaleString() : '—'}</td><td className="p-4">{metrics.data ? share(fallback, metrics.data.total) : '—'}</td><td className="p-4"><RouterStatus router={router} /></td><td className="p-4 text-right"><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Actions for ${router.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
    <DropdownMenuItem asChild><Link to="/integration/routers/$routerId" params={{routerId: router.id}}><ArrowUpRight />{t('查看详情', 'View details')}</Link></DropdownMenuItem>
    <DropdownMenuItem asChild><Link to="/integration/routers/$routerId" params={{routerId: router.id}} search={{tab: 'revisions'}}><History />{t('查看版本', 'View revisions')}</Link></DropdownMenuItem>
  </DropdownMenuContent></DropdownMenu></td></tr>;
}
export function RouterStatus({ router, revisionLabel }: { router: TrafficRouter; revisionLabel?: string }) {
  const t = useRoutingText();
  return <span className="text-sm">{router.rolloutStatus === 'failed' ? t('分发失败', 'Rollout failed') : router.rolloutStatus === 'active' ? t('已生效', 'Active') : router.rolloutStatus === 'distributing' ? t('分发中', 'Distributing') : t('未发布', 'Unpublished')}{router.activeRevision ? ` · ${revisionLabel ?? `r${router.activeRevision}`}` : ''}{router.draftRevision !== router.activeDraftRevision && ` · ${t('有草稿', 'Draft changes')}`}</span>;
}

export function TrafficScopeBadges({ router }: { router: TrafficRouter }) {
  const legacy = router as TrafficRouter & { traffic_scope?: { conditions?: unknown[] }; is_default?: boolean };
  if (!router.activeSnapshot && legacy.traffic_scope) {
    return <div className="flex flex-wrap gap-2 text-xs"><span className="rounded border px-2 py-1">{legacy.is_default ? 'routers.unmatchedTraffic' : 'All traffic'}</span></div>;
  }
  return <div className="flex flex-wrap gap-2 text-xs">{router.activeSnapshot?.routes.map(route => <span key={route.id} className="rounded border px-2 py-1">{route.name} · {route.kind === 'fallback' ? 'Fallback' : route.enabled ? 'Enabled' : 'Disabled'} · {route.targets.map(target => `${target.guardrailId} ${target.guardrailVersion} ${target.weightBps / 100}%`).join(' / ')}</span>)}</div>;
}
