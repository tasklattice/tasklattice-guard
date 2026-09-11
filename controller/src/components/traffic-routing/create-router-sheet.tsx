import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EntitySheet } from '@/components/entity-sheet';
import { ErrorNotice } from '@/components/product-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MultiSelectCombobox } from '@/components/ui/multi-select-combobox';
import { listControllerEndpoints } from '@/lib/controller-api';
import { createTrafficRouter, getSelectorFields, listTrafficRouters, trafficRouterKeys, type TrafficRoute } from '@/lib/traffic-routing-api';
import { routingIssues } from '../../../shared/traffic-routing';
import { Field, useRoutingText } from './form';
import { SelectorEditor } from './selector-editor';
import { TargetsEditor } from './targets-editor';

const newRoute = (kind: TrafficRoute['kind']): TrafficRoute => ({
  id: crypto.randomUUID(), name: kind === 'fallback' ? 'Fallback' : 'Route', kind, enabled: true,
  selector: { expression: { combinator: 'and', conditions: [] } }, targets: [],
});

export function CreateRouterSheet({ open, onOpenChange, onCreated }: {
  open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void;
}) {
  const t = useRoutingText();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [endpointIds, setEndpointIds] = useState<string[]>([]);
  const [routes, setRoutes] = useState(() => [newRoute('normal')]);
  const [fallback, setFallback] = useState(() => newRoute('fallback'));
  const endpoints = useQuery({ queryKey: ['routing-source-endpoints'], queryFn: listControllerEndpoints, enabled: open });
  const routers = useQuery({ queryKey: trafficRouterKeys.all, queryFn: listTrafficRouters, enabled: open });
  const fields = useQuery({ queryKey: ['routing-fields', endpointIds], queryFn: () => getSelectorFields(endpointIds), enabled: open && endpointIds.length > 0 });
  const draft = { routes: [...routes, fallback] };
  const issues = routingIssues(draft, true);
  const mutation = useMutation({
    mutationFn: () => createTrafficRouter({ name: name.trim(), endpointIds, draft }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: trafficRouterKeys.all });
      onCreated();
    },
  });
  const options = (endpoints.data?.items ?? []).map(endpoint => {
    const owner = routers.data?.items.find(router => router.endpointIds.includes(endpoint.id));
    return { value: endpoint.id, label: endpoint.name, meta: endpoint.adapter, disabled: Boolean(owner),
      description: owner ? t('已绑定', 'Bound to') + ' ' + owner.name : undefined };
  });
  const updateRoute = (next: TrafficRoute) => setRoutes(current => current.map(route => route.id === next.id ? next : route));

  return <EntitySheet width="xl" open={open} closeDisabled={mutation.isPending} onOpenChange={onOpenChange}
    eyebrow="Router" title={t('创建 Router', 'Create Router')}
    description={t('选择来源流量，按条件分发到 Guardrails。', 'Select incoming traffic and route it to Guardrails.')}
    footer={<><Button variant="outline" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>{t('取消', 'Cancel')}</Button>
      <Button disabled={!name.trim() || !endpointIds.length || issues.length > 0 || mutation.isPending || !routers.data || !endpoints.data}
        onClick={() => mutation.mutate()}>{mutation.isPending ? t('创建中…', 'Creating…') : t('创建 Router', 'Create Router')}</Button></>}>
    <div className="space-y-6">
      <Field label={t('Router 名称', 'Router name')}><Input autoFocus value={name} onChange={event => setName(event.target.value)} /></Field>
      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t('来源 Endpoint', 'Source Endpoints')}</h3>
        <MultiSelectCombobox ariaLabel={t('来源 Endpoint', 'Source Endpoints')} options={options} value={endpointIds}
          onValueChange={setEndpointIds} disabled={endpoints.isPending || routers.isPending}
          placeholder={t('搜索或选择 Endpoint…', 'Search or select Endpoints…')} />
        <p className="text-xs text-muted-foreground">{t('所选 Endpoint 共用以下路由规则；每个 Endpoint 只能属于一个 Router。', 'Selected Endpoints share these rules. Each Endpoint belongs to one Router.')}</p>
        {endpoints.error && <ErrorNotice error={endpoints.error} />}{routers.error && <ErrorNotice error={routers.error} />}
      </div>
      <section className="space-y-4">
        <h3 className="font-medium">{t('路由规则', 'Route settings')}</h3>
        {fields.error && <ErrorNotice error={fields.error} />}
        {routes.map((route, index) => <div key={route.id} className="space-y-4 rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between"><h4 className="text-sm font-medium">Route {index + 1}</h4>
            <Button variant="ghost" onClick={() => setRoutes(current => current.filter(item => item.id !== route.id))}>{t('删除规则', 'Remove route')}</Button></div>
          <SelectorEditor value={route.selector.expression} fields={fields.data?.items}
            onChange={expression => updateRoute({ ...route, selector: { expression } })} />
          <div className="space-y-2 border-t pt-4"><h4 className="text-sm font-medium">{t('转发到', 'Forward to')}</h4>
            <TargetsEditor value={route.targets} onChange={targets => updateRoute({ ...route, targets })} /></div>
        </div>)}
        <Button variant="outline" disabled={routes.length >= 127} onClick={() => setRoutes(current => [...current, { ...newRoute('normal'), name: `Route ${current.length + 1}` }])}>{t('添加 Route', 'Add route')}</Button>
      </section>
      <section className="space-y-3 rounded-lg border bg-card p-4">
        <h3 className="text-sm font-medium">{t('其余流量', 'Unmatched traffic')}</h3>
        <p className="text-xs text-muted-foreground">{t('未命中以上规则的流量转发到：', 'Traffic that matches none of the rules is forwarded to:')}</p>
        <TargetsEditor value={fallback.targets} onChange={targets => setFallback(current => ({ ...current, targets }))} />
      </section>
      {issues.length > 0 && <p className="text-xs text-muted-foreground">{t('请完善每条规则的条件和 Guardrail，并确保分发比例合计为 100%。', 'Complete the conditions and Guardrails for each rule. Distribution must total 100%.')}</p>}
      {mutation.error && <ErrorNotice error={mutation.error} />}
    </div>
  </EntitySheet>;
}
