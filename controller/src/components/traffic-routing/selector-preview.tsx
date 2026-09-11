import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ErrorNotice } from '@/components/product-shell';
import { Field, useRoutingText } from './form';
import { testTrafficSelector, type RouterDraft } from '@/lib/traffic-routing-api';
import { routingInputSchema } from '../../../shared/traffic-routing';
export function SelectorPreviewPanel({ routerId, draft, endpointIds }: { routerId: string; draft: RouterDraft; endpointIds: string[] }) {
  const t = useRoutingText();
  const [sample, setSample] = useState(() => JSON.stringify({ endpointId: endpointIds[0] ?? 'simulated-endpoint', fields: {}, business_request: { 'x-channel': ['partner'] }, endpoint_request: {} }, null, 2));
  const mutation = useMutation({ mutationFn: () => testTrafficSelector(routerId, draft, routingInputSchema.parse(JSON.parse(sample))) });
  return <section className="space-y-3 border-t pt-5"><h3 className="font-semibold">{t('测试 Selector 与 Router 顺序', 'Test Selector and Router order')}</h3><p className="text-sm text-muted-foreground">{endpointIds.length ? t('脱敏样本，仅测试匹配；不执行 Guardrail、不计入统计。', 'Redacted sample: match only; no Guardrail execution or statistics.') : t('模拟输入：未绑定 Endpoint，实际发布与绑定仍需能力校验。', 'Simulated input: no Endpoint is bound. Publish and binding still validate capabilities.')}</p>
    <Field label={t('请求样本 JSON（仅本次预览）', 'Request sample JSON (this preview only)')}><Textarea className="min-h-48 font-mono text-xs" value={sample} onChange={e => { setSample(e.target.value); mutation.reset(); }} /></Field>
    <p className="text-xs text-muted-foreground">{t('Header 使用值数组；凭据 Header 不进入预览。HTTP method/path/host 使用 :method/:path/:host。', 'Headers use value arrays; credential headers are excluded. HTTP method/path/host use :method/:path/:host.')}</p>
    <Button className="min-h-11" disabled={mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? t('测试中…', 'Testing…') : t('测试 Selector', 'Test Selector')}</Button>
    {mutation.error && <ErrorNotice error={mutation.error} />}
    {mutation.data && <div aria-live="polite" className="space-y-2">{mutation.data.items.map(row => <article key={row.routeId} className="rounded-md border p-3 text-sm"><strong>{draft.routes.find(r => r.id === row.routeId)?.name ?? row.routeId}</strong><p>{t('独立匹配', 'Independent match')}: {String(row.independentMatch)} · {row.received ? t('由此 Route 接收', 'Received by this Route') : row.state === 'not_evaluated' ? t('按顺序未评估', 'Not evaluated in order') : row.state === 'not_applicable' ? t('不适用', 'Not applicable') : t('未匹配', 'Not matched')}</p>{row.blockedBy && <p>{t('优先接收', 'Received earlier by')}: {draft.routes.find(r => r.id === row.blockedBy)?.name ?? row.blockedBy}</p>}<details className="mt-2"><summary className="min-h-11 cursor-pointer py-2">{t('逐条件结果与原因', 'Condition results and reasons')}</summary><pre className="overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(row.children, null, 2)}</pre></details></article>)}<details><summary className="min-h-11 cursor-pointer py-2">{t('规范化输入', 'Normalized input')}</summary><pre className="overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(mutation.data.normalizedInput ?? {}, null, 2)}</pre></details></div>}
  </section>;
}
