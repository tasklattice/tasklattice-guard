import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearch, useBlocker, useNavigate } from '@tanstack/react-router';
import { useAuth } from '@/lib/auth';
import { listControllerEndpoints } from '@/lib/controller-api';
import * as api from '@/lib/traffic-routing-api';
import { routingIssues } from '../../shared/traffic-routing';
import { PageHeader, ErrorNotice } from '@/components/product-shell';
import { EntitySheet } from '@/components/entity-sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MultiSelectCombobox } from '@/components/ui/multi-select-combobox';
import { Field, percent, useRoutingText } from '@/components/traffic-routing/form';
import { SelectorEditor } from '@/components/traffic-routing/selector-editor';
import { TargetsEditor } from '@/components/traffic-routing/targets-editor';
import { SelectorPreviewPanel } from '@/components/traffic-routing/selector-preview';
import { DistributionOverview } from '@/components/traffic-routing/distribution';
import { RouterStatus } from './routers';
export { DeleteRouterSheet, RouterRuntimeEventTable } from '@/components/traffic-routing/runtime-events';

export function RouterDetailPage() {
  const { routerId } = useParams({ strict: false });
  const query = useQuery({ queryKey: api.trafficRouterKeys.detail(routerId!), queryFn: () => api.getTrafficRouter(routerId!), refetchInterval: 10000 });
  if (query.error) return <section className="py-8"><ErrorNotice error={query.error} /><Button onClick={() => void query.refetch()}>Retry</Button></section>;
  if (!query.data) return <p role="status">Loading Router…</p>;
  return <RouterWorkspace key={query.data.id} router={query.data} />;
}
export function RouterWorkspace({ router }: { router: api.TrafficRouter }) {
  const t = useRoutingText();
  const auth = useAuth();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const canEdit = auth.user?.role === 'admin';
  const client = useQueryClient();
  const search = useSearch({ strict: false }) as { routeId?: string };
  const [tab, setTab] = useState(search.routeId ? 'config' : 'overview');
  const [selected, setSelected] = useState<string | null>(search.routeId ?? null);
  const [base, setBase] = useState(router);
  const [draft, setDraft] = useState(router.draft);
  const [name, setName] = useState(router.name);
  const [description, setDescription] = useState(router.description);
  const [binding, setBinding] = useState<string[] | undefined>(undefined);
  const [publish, setPublish] = useState<{ revision?: number; key: string } | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base.draft) || name !== base.name || description !== base.description;
  const blocker = useBlocker({ shouldBlockFn: () => dirty, withResolver: true, enableBeforeUnload: dirty });
  useEffect(() => { if (!dirty) { setBase(router); setDraft(router.draft); setName(router.name); setDescription(router.description); } }, [router, dirty]);
  const endpoints = useQuery({ queryKey: ['routing-endpoints-native'], queryFn: listControllerEndpoints });
  const fields = useQuery({ queryKey: ['selector-fields', router.endpointIds], queryFn: () => api.getSelectorFields(router.endpointIds) });
  const revisions = useQuery({ queryKey: [...api.trafficRouterKeys.detail(router.id), 'revisions'], queryFn: () => api.getRouterRevisions(router.id) });
  const accept = async (next: api.TrafficRouter) => { setBase(next); setDraft(next.draft); setName(next.name); setDescription(next.description); client.setQueryData(api.trafficRouterKeys.detail(router.id), next); await client.invalidateQueries({ queryKey: api.trafficRouterKeys.all }); };
  const save = useMutation({ mutationFn: async () => {
    let next = base;
    if (JSON.stringify(draft) !== JSON.stringify(base.draft)) next = await api.saveTrafficRouter(router.id, base.draftRevision, draft);
    if (name !== base.name || description !== base.description) next = await api.renameTrafficRouter(router.id, name, description);
    return next;
  }, onSuccess: accept });
  const release = useMutation({ mutationFn: () => publish?.revision ? api.rollbackTrafficRouter(router.id, base.draftRevision, publish.revision, publish.key) : api.publishTrafficRouter(router.id, base.draftRevision, publish!.key), onSuccess: async next => { await accept(next); setPublish(null); } });
  const bind = useMutation({ mutationFn: () => api.bindTrafficRouter(router.id, binding ?? []), onSuccess: async next => { client.setQueryData(api.trafficRouterKeys.detail(router.id), next); setBinding(undefined); await client.invalidateQueries({ queryKey: api.trafficRouterKeys.all }); await client.invalidateQueries({ queryKey: ['routing-endpoints-native'] }); } });
  const issues = routingIssues(draft, true);
  const route = draft.routes.find(r => r.id === selected);
  const updateRoute = (next: api.TrafficRoute) => setDraft({ routes: draft.routes.map(r => r.id === next.id ? next : r) });
  const move = (index: number, delta: number) => { const routes = [...draft.routes]; const target = index + delta; if (target < 0 || target >= routes.length - 1) return; [routes[index], routes[target]] = [routes[target]!, routes[index]!]; setDraft({ routes }); };
  const remove = useMutation({ mutationFn: () => api.deleteTrafficRouter(router.id), onSuccess: async () => { await client.invalidateQueries({ queryKey: api.trafficRouterKeys.all }); void navigate({ to: '/integration/routers' }); } });
  const busy = save.isPending || release.isPending;
  return <section className="space-y-5 py-8">
    <Link className="inline-flex min-h-11 items-center text-primary" to="/integration/routers">← Routers</Link>
    <PageHeader title={router.name} description={router.description} action={<div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setTab('config')}>{t('编辑路由', 'Edit routes')}</Button>{canEdit && <Button disabled={dirty || busy || issues.length > 0 || (base.draftRevision === router.activeDraftRevision && router.rolloutStatus !== 'failed')} title={dirty ? t('请先保存草稿', 'Save draft first') : issues.join('\n') || t('发布已保存的草稿改动', 'Publish saved draft changes')} onClick={() => { release.reset(); setPublish({ key: crypto.randomUUID() }); }}>{t('发布配置', 'Publish configuration')}</Button>}</div>} />
    <RouterStatus router={router} />{router.rolloutStatus === 'failed' && <p role="alert">{(router as api.TrafficRouter & { rolloutError?: string | null }).rolloutError ?? t('Runner 分发失败。可重试发布或将历史内容发布为新 revision。', 'Runner rollout failed. Retry publication or publish a historical revision.')} {canEdit && <Button variant="outline" disabled={dirty} onClick={() => setPublish({ key: crypto.randomUUID() })}>{t('重试发布', 'Retry publish')}</Button>}</p>}<p className="text-sm">Endpoints: {router.endpointIds.map(id => endpoints.data?.items.find(e => e.id === id)?.name ?? id).join(', ') || t('未接入', 'Unbound')} · Draft r{base.draftRevision}{dirty && ` · ${t('未保存', 'Unsaved')}`}</p>
    {router.draftRevision !== base.draftRevision && dirty && <p role="alert">{t('服务器草稿已变更。本地编辑已保留，请比较服务器内容后重新加载。', 'The server draft changed. Local edits are preserved; compare server content before reloading.')}<details><summary>Server draft r{router.draftRevision}</summary><pre className="overflow-auto">{JSON.stringify(router.draft, null, 2)}</pre></details></p>}
    <nav className="flex gap-2" aria-label="Router views">{[['overview', t('总览', 'Overview')], ['config', t('路由配置', 'Configuration')], ['revisions', t('变更记录', 'Revisions')]].map(([id, label]) => <Button key={id} variant={tab === id ? 'secondary' : 'ghost'} aria-pressed={tab === id} onClick={() => setTab(id!)}>{label}</Button>)}</nav>
    {tab === 'overview' && <DistributionOverview router={router} endpoints={endpoints.data?.items ?? []} />}
    {tab === 'config' && <div className="space-y-5">
      {canEdit && <><Field label={t('名称', 'Name')}><Input value={name} onChange={e => setName(e.target.value)} /></Field><div className="flex flex-wrap gap-2"><Button disabled={!dirty || busy || !name.trim() || routingIssues(draft).length > 0} onClick={() => save.mutate()}>{save.isPending ? t('保存中…', 'Saving…') : t('保存草稿', 'Save draft')}</Button><Button variant="outline" disabled={!dirty || busy} onClick={() => { if (window.confirm(t('丢弃本地修改并加载服务器草稿？', 'Discard local edits and load the server draft?'))) { setBase(router); setDraft(router.draft); setName(router.name); setDescription(router.description); save.reset(); } }}>{t('丢弃并重新加载', 'Discard and reload')}</Button><Button variant="outline" onClick={() => setBinding([...router.endpointIds])}>{t('绑定 Endpoints', 'Bind source Endpoints')}</Button><Button variant="outline" disabled={router.endpointIds.length > 0 || dirty} onClick={() => setDeleting(true)}>{t('删除 Router', 'Delete Router')}</Button><Button variant="outline" disabled={draft.routes.length >= 128} onClick={() => { const id = crypto.randomUUID(); setDraft({ routes: [...draft.routes.slice(0, -1), { id, name: 'New Route', kind: 'normal', enabled: true, selector: { expression: { combinator: 'and', conditions: [] } }, targets: [] }, ...draft.routes.slice(-1)] }); setSelected(id); }}>{t('添加 Route', 'Add Route')}</Button></div></>}
      {save.error && <ErrorNotice error={save.error} />}
      <p className="text-sm text-muted-foreground">{t('首条命中；Fallback 固定末尾。启停、排序和权重均在发布后影响新调用。', 'First match wins; Fallback stays last. Enablement, order and weights affect new calls after publishing.')}</p>
      {draft.routes.filter(r => r.kind === 'normal').length === 0 && <p>{t('全部流量进入 Fallback', 'All traffic enters Fallback')}</p>}
      {draft.routes.map((r, index) => <article key={r.id} className="space-y-2 rounded-md border p-4"><div className="flex flex-wrap items-center gap-3"><Button variant="link" onClick={() => setSelected(r.id)}>{r.kind === 'fallback' ? 'Fallback' : String(index + 1).padStart(2, '0')} · {r.name}</Button>{canEdit && r.kind !== 'fallback' && <><label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={r.enabled} onChange={e => updateRoute({ ...r, enabled: e.target.checked })} />{t('草稿启用', 'Enabled in draft')}</label><Button variant="outline" aria-label={`Move ${r.name} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</Button><Button variant="outline" aria-label={`Move ${r.name} down`} disabled={index >= draft.routes.length - 2} onClick={() => move(index, 1)}>↓</Button><Button variant="ghost" onClick={() => setDraft({ routes: draft.routes.filter(item => item.id !== r.id) })}>{t('删除', 'Remove')}</Button></>}</div><p className="break-words text-sm">{r.kind === 'fallback' ? t('其余流量', 'Remaining traffic') : JSON.stringify(r.selector.expression)} → {r.targets.map(target => `${target.guardrailId} ${target.guardrailVersion || '—'} ${percent(target.weightBps)}`).join(' / ')}</p></article>)}
      {issues.length > 0 && <div role="status" className="rounded-md border p-4"><h3>{t('发布前需修正', 'Required before publishing')}</h3><ul className="list-disc pl-5">{issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></div>}
    </div>}
    {tab === 'revisions' && <div className="space-y-3">{revisions.error && <><ErrorNotice error={revisions.error} /><Button onClick={() => void revisions.refetch()}>Retry</Button></>}{revisions.isPending && <p>Loading…</p>}{revisions.data?.items.length === 0 && <p>{t('尚未发布', 'No published revisions')}</p>}{revisions.data?.items.map(r => <article key={r.revision} className="rounded-md border p-4"><p>r{r.revision} · {new Date(r.createdAt).toLocaleString()} · {r.createdBy}</p><details><summary className="min-h-11 cursor-pointer py-3">{t('查看不可变快照', 'View immutable snapshot')}</summary><pre className="overflow-auto text-xs">{JSON.stringify(r.snapshot, null, 2)}</pre></details>{canEdit && <Button disabled={dirty || busy} onClick={() => { release.reset(); setPublish({ revision: r.revision, key: crypto.randomUUID() }); }}>{t('将此内容发布为新 revision', 'Publish this content as a new revision')}</Button>}</article>)}</div>}
    {route && <EntitySheet open width="xl" onOpenChange={open => { if (!open) setSelected(null); }} eyebrow="Route" title={route.name} description={t('编辑保留在 Router 草稿中；关闭面板不会丢失。', 'Edits stay in the Router draft when this panel closes.')} footer={<Button onClick={() => setSelected(null)}>{t('完成', 'Done')}</Button>}><fieldset disabled={!canEdit || busy} className="space-y-6"><Field label="Route name"><Input value={route.name} onChange={e => updateRoute({ ...route, name: e.target.value })} /></Field><h3 className="font-semibold">Traffic Selector · {t('选择来源 Endpoint 的流量', 'Select traffic from the source Endpoint')}</h3>{route.kind === 'normal' ? <><p className="text-sm text-muted-foreground">{t('此 Route 只处理 Router 顶部指定 Endpoint 的输入流量。', 'This Route only evaluates input traffic from the Endpoint bound to this Router.')}</p>{fields.error && <ErrorNotice error={fields.error} />}<SelectorEditor value={route.selector.expression} fields={fields.data?.items} onChange={expression => updateRoute({ ...route, selector: { ...route.selector, expression } })} /></> : <p>{t('Fallback 始终启用且不含条件。', 'Fallback is always enabled and unconditional.')}</p>}<h3 className="font-semibold">Distribution · {t('分配目标', 'Distribute targets')}</h3><TargetsEditor value={route.targets} onChange={targets => updateRoute({ ...route, targets })} /></fieldset><SelectorPreviewPanel routerId={router.id} draft={draft} endpointIds={router.endpointIds} /></EntitySheet>}
    {binding !== undefined && <EntitySheet eyebrow="Router" open onOpenChange={open => { if (!open && !bind.isPending) setBinding(undefined); }} title={t('绑定来源 Endpoints', 'Bind source Endpoints')} description={t('一个 Router 可以接收多个 Endpoint；每个 Endpoint 只能属于一个 Router。', 'A Router can receive multiple Endpoints; each Endpoint can belong to only one Router.')} footer={<Button disabled={bind.isPending} onClick={() => bind.mutate()}>{t('保存绑定', 'Save bindings')}</Button>}><div className="space-y-3">{endpoints.error && <ErrorNotice error={endpoints.error} />}<MultiSelectCombobox ariaLabel={t('来源 Endpoint', 'Source Endpoints')} disabled={bind.isPending} options={(endpoints.data?.items ?? []).map(endpoint => ({ value: endpoint.id, label: endpoint.name, meta: endpoint.adapter }))} value={binding} onValueChange={setBinding} />{bind.error && <ErrorNotice error={bind.error} />}</div></EntitySheet>}
    {publish && <EntitySheet eyebrow="Router" open closeDisabled={release.isPending} onOpenChange={open => { if (!open && !release.isPending) setPublish(null); }} title={t('发布预览', 'Publish preview')} description={t('新调用使用新 revision；既有调用保持原分配。控制面保存后仍需等待 Runner 分发。', 'New calls use the new revision. Existing calls keep their assignment. Runner rollout follows control-plane publication.')} footer={<Button disabled={release.isPending} onClick={() => release.mutate()}>{release.isPending ? t('发布中…', 'Publishing…') : t('确认发布', 'Confirm publish')}</Button>}><p>{t('受影响 Endpoints', 'Affected Endpoints')}: {router.endpointIds.map(id => endpoints.data?.items.find(e => e.id === id)?.name ?? id).join(', ') || t('未接入', 'Unbound')}</p><div className="grid gap-4"><details><summary>Before · r{router.activeRevision ?? '—'}</summary><pre className="overflow-auto text-xs">{JSON.stringify(router.activeSnapshot, null, 2)}</pre></details><details open><summary>After · {publish.revision ? `source r${publish.revision}` : `draft r${base.draftRevision}`}</summary><pre className="overflow-auto text-xs">{JSON.stringify(publish.revision ? revisions.data?.items.find(r => r.revision === publish.revision)?.snapshot : base.draft, null, 2)}</pre></details></div>{release.error && <ErrorNotice error={release.error} />}</EntitySheet>}
    {deleting && <EntitySheet eyebrow="Router" open closeDisabled={remove.isPending} onOpenChange={open => { if (!remove.isPending) setDeleting(open); }} title={t('删除 Router', 'Delete Router')} description={t('仅可删除未绑定的 Router。历史快照保留。', 'Only unbound Routers can be deleted. Historical snapshots are retained.')} footer={<Button disabled={remove.isPending} onClick={() => remove.mutate()}>{t('确认删除', 'Confirm deletion')}</Button>}><p>{router.name}</p>{remove.error && <ErrorNotice error={remove.error} />}</EntitySheet>}
    {blocker.status === 'blocked' && <EntitySheet eyebrow="Router" open onOpenChange={() => blocker.reset()} title={t('未保存修改', 'Unsaved edits')} description={t('离开会丢弃本地修改。', 'Leaving discards local edits.')} footer={<><Button variant="outline" onClick={() => blocker.reset()}>{t('继续编辑', 'Keep editing')}</Button><Button onClick={() => blocker.proceed()}>{t('丢弃并离开', 'Discard and leave')}</Button></>}><p>{t('请保存 Router 草稿以保留修改。', 'Save the Router draft to preserve changes.')}</p></EntitySheet>}
  </section>;
}
