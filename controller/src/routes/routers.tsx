import { ResourceList } from '@/components/resource-list';
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '@/components/ui/table';
import { useTranslation } from 'react-i18next';
import { CreateRouterSheet } from '@/components/traffic-routing/create-router-sheet';
export { CreateRouterSheet } from '@/components/traffic-routing/create-router-sheet';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus, MoreHorizontal, History, ArrowUpRight, GitBranch } from 'lucide-react';
import { PageHeader, StateBadge } from '@/components/product-shell';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { share } from '@/components/traffic-routing/form';
import { useAuth } from '@/lib/auth';
import { getEndpoints } from '@/lib/api';
import { getRouterDistribution, listTrafficRouters, trafficRouterKeys, type TrafficRouter } from '@/lib/traffic-routing-api';

export function RoutersPage() {
  const { t: localize } = useTranslation();
  const { t } = useTranslation();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const routers = useQuery({ queryKey: trafficRouterKeys.all, queryFn: listTrafficRouters });
  const endpoints = useQuery({ queryKey: ['routing-endpoints'], queryFn: getEndpoints });
  const { t: translate } = useTranslation();
  const navigate = useNavigate();
  const endpointName = (id: string) => endpoints.data?.items.find(item => item.id === id)?.name ?? id;
  return <section className="py-8">
    <PageHeader title={t("routing.trafficRouters")} description={t("routing.selectTrafficInRouteOrderThenDistributeEachRoute")} />
    <ResourceList items={routers.data?.items ?? []} label={t("routing.trafficRouters")} searchPlaceholder={translate('resourceList.searchRouters')}
      searchText={item => `${item.name} ${item.id} ${item.description} ${item.endpointIds.map(id => `${id} ${endpointName(id)}`).join(' ')}`}
      filter={{ label: t("routing.rollout"), options: [{ value: '', label: translate('resourceList.allStatuses') }, ...['unpublished', 'distributing', 'active', 'failed'].map(value => ({ value, label: rolloutLabel(value, t) }))], matches: (item, value) => item.rolloutStatus === value }}
      loading={routers.isPending} refreshing={routers.isFetching || endpoints.isFetching} error={routers.error} onRefresh={() => { void queryClient.invalidateQueries({ queryKey: trafficRouterKeys.all }); void endpoints.refetch(); }}
      emptyTitle={t("routing.noRoutersYet")} emptyDescription={t("routing.chooseSourceEndpointsRoutingRulesAndADefaultGuardrail")}
      action={auth.user?.role === 'admin' ? <Button variant="create" size="lg" onClick={() => setOpen(true)}><Plus />{t("routing.createRouter")}</Button> : undefined}>
      {items => <Table className="resource-table resource-router-table" aria-label={t("routing.trafficRouters")}><TableHeader><TableRow>
        {[localize("routing.router"), localize("routing.endpoints2"), t("routing.enabledRoutes"), t("routing.24hCalls"), localize("routing.fallback"), t("routing.rollout")].map((label, index) => <TableHead key={label} className={index === 0 ? 'resource-name-column' : index === 1 ? 'resource-endpoints-column' : index === 5 ? 'resource-rollout-column' : undefined}>{label}</TableHead>)}
        <TableHead className="resource-actions-column"><span className="sr-only">{t("routing.actions")}</span></TableHead>
      </TableRow></TableHeader><TableBody>{items.map(router => <RouterRow key={router.id} router={router} endpointName={endpointName} onOpen={() => void navigate({ to: '/integration/routers/$routerId', params: { routerId: router.id } })} />)}</TableBody></Table>}
    </ResourceList>
    {open && <CreateRouterSheet open onOpenChange={setOpen} onCreated={() => setOpen(false)} />}
  </section>;
}

function RouterRow({ router, endpointName, onOpen }: { router: TrafficRouter; endpointName: (id: string) => string; onOpen: () => void }) {
  const { t: localize } = useTranslation();
  const { t } = useTranslation();
  const metrics = useQuery({ queryKey: [...trafficRouterKeys.detail(router.id), 'distribution', 24], queryFn: () => getRouterDistribution(router.id), retry: false });
  const fallbackIds = new Set(router.activeSnapshot?.routes.filter(r => r.kind === 'fallback').map(r => r.id));
  const fallback = metrics.data?.rows.filter(r => r.routeId !== null && fallbackIds.has(r.routeId)).reduce((n, r) => n + r.count, 0) ?? 0;
  return <TableRow className="resource-row" onClick={onOpen}><TableCell><Link className="resource-name" onClick={event => event.stopPropagation()} to="/integration/routers/$routerId" params={{ routerId: router.id }}><GitBranch aria-hidden="true" className="size-4 shrink-0" /><span>{router.name}</span></Link><span className="resource-secondary" title={router.description || router.id}>{router.description || router.id}</span></TableCell><TableCell>{router.endpointIds.length ? router.endpointIds.map(endpointName).join(', ') : t("routing.unbound")}</TableCell><TableCell className="tabular-nums">{router.draft.routes.filter(r => r.kind === 'normal' && r.enabled).length} + 1 {localize("routing.fallback")}</TableCell><TableCell className="tabular-nums">{metrics.error ? t("routing.dataUnavailable") : metrics.data ? metrics.data.total.toLocaleString() : '—'}</TableCell><TableCell>{metrics.data ? share(fallback, metrics.data.total) : '—'}</TableCell><TableCell><StateBadge state={router.rolloutStatus} label={rolloutLabel(router.rolloutStatus, t)} /><span className="resource-secondary">{[router.activeRevision ? `r${router.activeRevision}` : '', router.draftRevision !== router.activeDraftRevision ? t("routing.draftChanges") : ''].filter(Boolean).join(' · ')}</span></TableCell><TableCell className="resource-actions-column" onClick={event => event.stopPropagation()}><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`${t("routing.actions")}: ${router.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
    <DropdownMenuItem asChild><Link to="/integration/routers/$routerId" params={{routerId: router.id}}><ArrowUpRight />{t("routing.viewDetails")}</Link></DropdownMenuItem>
    <DropdownMenuItem asChild><Link to="/integration/routers/$routerId" params={{routerId: router.id}} search={{tab: 'revisions'}}><History />{t("routing.viewRevisions")}</Link></DropdownMenuItem>
  </DropdownMenuContent></DropdownMenu></TableCell></TableRow>;
}
function rolloutLabel(status: string, t: (key: string) => string) {
  return status === 'failed' ? t("routing.rolloutFailed") : status === 'active' ? t("routing.active") : status === 'distributing' ? t("routing.distributing") : t("routing.unpublished");
}
export function RouterStatus({ router, revisionLabel }: { router: TrafficRouter; revisionLabel?: string }) {
  const { t } = useTranslation();
  return <span className="text-sm">{rolloutLabel(router.rolloutStatus, t)}{router.activeRevision ? ` · ${revisionLabel ?? `r${router.activeRevision}`}` : ''}{router.draftRevision !== router.activeDraftRevision && ` · ${t("routing.draftChanges")}`}</span>;
}

export function TrafficScopeBadges({ router }: { router: TrafficRouter }) {
  const { t: localize } = useTranslation();
  return <div className="flex flex-wrap gap-2 text-xs">{router.activeSnapshot?.routes.map(route => <span key={route.id} className="rounded border px-2 py-1">{route.name} · {route.kind === 'fallback' ? localize("routing.fallback") : route.enabled ? localize("routing.enabled") : localize("routing.disabled")} · {route.targets.map(target => `${target.guardrailId} ${target.guardrailVersion} ${target.weightBps / 100}%`).join(' / ')}</span>)}</div>;
}
