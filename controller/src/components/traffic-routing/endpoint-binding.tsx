import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { listTrafficRouters, trafficRouterKeys } from '@/lib/traffic-routing-api';
import { requestController } from '@/lib/controller-api';
import { useAuth } from '@/lib/auth';
import { ErrorNotice } from '@/components/product-shell';
import { Button } from '@/components/ui/button';
import { Field, NativeSelect, useRoutingText } from './form';
export function EndpointRouterBinding({ endpointId }: { endpointId: string }) {
  const t = useRoutingText();
  const client = useQueryClient();
  const auth = useAuth();
  const query = useQuery({ queryKey: trafficRouterKeys.all, queryFn: listTrafficRouters });
  const current = query.data?.items.find(router => router.endpointIds.includes(endpointId));
  const [choice, setChoice] = useState<string | null>(null);
  const mutation = useMutation({ mutationFn: () => requestController(`/api/v1/endpoints/${encodeURIComponent(endpointId)}`, { method: 'PATCH', body: JSON.stringify({ routerId: choice || null }) }), onSuccess: async () => { setChoice(null); await client.invalidateQueries({ queryKey: trafficRouterKeys.all }); await client.invalidateQueries({ queryKey: ['controller'] }); } });
  return <section className="space-y-3 rounded-md border p-4"><h3 className="font-semibold">Router</h3>{current ? <Link className="inline-flex min-h-11 items-center text-primary" to="/integration/routers/$routerId" params={{ routerId: current.id }}>{current.name} · r{current.activeRevision}</Link> : <p>{t('未绑定 Router，不能接收评估调用。', 'No Router is bound; evaluation calls are unavailable.')}</p>}{query.error && <><ErrorNotice error={query.error} /><Button onClick={() => void query.refetch()}>Retry</Button></>}{auth.user?.role === 'admin' && <><Field label={t('已发布 Router', 'Published Router')}><NativeSelect disabled={mutation.isPending || !query.data} value={choice ?? current?.id ?? ''} onChange={e => setChoice(e.target.value)}><option value="">{t('解除绑定（需先停用 Endpoint）', 'Unbind (disable Endpoint first)')}</option>{query.data?.items.filter(router => router.activeRevision).map(router => <option key={router.id} value={router.id}>{router.name} · r{router.activeRevision}</option>)}</NativeSelect></Field><p className="text-xs text-muted-foreground">{t('绑定立即生效；共享 Router 的发布影响所有绑定接入。', 'Binding takes effect immediately. Publishing a shared Router affects all bound Endpoints.')}</p><Button disabled={choice === null || mutation.isPending} onClick={() => mutation.mutate()}>{t('保存绑定', 'Save binding')}</Button>{mutation.error && <ErrorNotice error={mutation.error} />}</>}</section>;
}
