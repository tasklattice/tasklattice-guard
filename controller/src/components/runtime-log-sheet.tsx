import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, Clock3, LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EntitySheet } from "@/components/entity-sheet";
import { EventPagination, useEventCursor } from "@/components/event-pagination";
import { EmptyState, ErrorNotice, StateBadge } from "@/components/product-shell";
import { RuntimeContentPanel } from "@/components/runtime-content-panel";
import { ExecutionTrace } from "@/components/execution-trace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getRuntimeEvent, listRuntimeEvents } from "@/lib/controller-api";
import { runtimeLogInteractions, type RuntimeLogEntry } from "@/lib/api";

export function RuntimeLogSheet({ requestId, guardrailId, checkpointId, onCheckpointChange, admin, guardrailName, routerName, open, onOpenChange }: {
  requestId?: string; guardrailId?: string; checkpointId?: string;
  onCheckpointChange?: (id?: string) => void;
  admin: boolean; guardrailName: (id: string | null) => string;
  routerName: (id: string | null) => string;
  open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const paging = useEventCursor(`${requestId}:${guardrailId}`);
  const [localCheckpointId, setLocalCheckpointId] = useState<string>();
  const selectCheckpoint = onCheckpointChange ?? setLocalCheckpointId;
  const checkpoints = useQuery({
    queryKey: ['interaction-checkpoints', requestId, guardrailId, paging.cursor],
    enabled: open && Boolean(requestId), gcTime: 0, refetchOnWindowFocus: false,
    queryFn: ({ signal }) => listRuntimeEvents(100, { requestId, guardrailId, ...(paging.cursor ? { cursor: paging.cursor } : {}) }, signal),
  });
  // Opening a record immediately loads its checkpoint, independently of the list page.
  const expanded = checkpointId ?? localCheckpointId ?? checkpoints.data?.items[0]?.id;
  useEffect(() => {
    if (open && expanded && !checkpointId && onCheckpointChange) onCheckpointChange(expanded);
  }, [open, expanded, checkpointId, onCheckpointChange]);
  const detail = useQuery({
    queryKey: ['checkpoint-detail', requestId, guardrailId, expanded], enabled: open && Boolean(expanded), gcTime: 0, refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const event = await getRuntimeEvent(expanded!, signal);
      if (event.requestId !== requestId || (guardrailId && event.guardrailId !== guardrailId)) {
        throw new Error(t('logs.checkpointMismatch'));
      }
      return runtimeLogInteractions([event], { includeUncaptured: true })[0] ?? null;
    },
  });
  const interaction = runtimeLogInteractions(checkpoints.data?.items ?? [], { includeUncaptured: true })[0] ?? detail.data;
  const entry = detail.data?.entries[0];
  return <EntitySheet open={open} onOpenChange={onOpenChange} eyebrow={t("logs.interactionDetailEyebrow")} title={t("logs.detailTitle")} description={<span className="break-all font-mono text-xs">{requestId}</span>} width="xl" footer={<Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>}>
    <div className="grid gap-5">
      {interaction ? <dl className="grid overflow-hidden rounded-lg border sm:grid-cols-2"><Fact label={t("logs.time")} value={new Date(interaction.created_at).toLocaleString(i18n.language)} /><Fact label={t("logs.outcome")} value={interaction.outcome} /><Fact label={t("logs.guardrail")} value={`${guardrailName(interaction.guardrail_id)} · ${interaction.guardrail_version ?? "—"}`} /><Fact label={t("logs.context")} value={`${routerName(interaction.router_id)} · ${interaction.protocol}`} /></dl> : null}
      {!admin && entry?.content_available ? <div className="flex gap-3 rounded-lg border bg-muted/25 p-4"><LockKeyhole className="mt-0.5 size-4 shrink-0" /><div><p className="text-sm font-medium">{t("logs.adminContentTitle")}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("logs.adminContentDescription")}</p></div></div> : null}
      {checkpoints.isPending && !expanded ? <p role="status">{t('logs.loadingDetail')}</p> : checkpoints.error ? <div><ErrorNotice error={checkpoints.error} /><Button variant="outline" onClick={() => void checkpoints.refetch()}>{t('common.retry')}</Button></div> : null}
      {(checkpoints.data?.items.length ?? 0) > 1 ? <div className="grid gap-2">{checkpoints.data?.items.map(event => <Button key={event.id} variant={expanded === event.id ? 'secondary' : 'outline'} className="h-auto min-h-11 justify-start whitespace-normal break-all text-left" onClick={() => selectCheckpoint(event.id)} aria-pressed={expanded === event.id}>{new Date(event.occurredAt).toLocaleString(i18n.language)} · {t(event.direction === 'incoming' ? 'logs.inboundCheckpoint' : 'logs.outboundCheckpoint')} · {event.id}</Button>)}</div> : null}
      {paging.page > 1 || checkpoints.data?.nextCursor ? <EventPagination page={paging.page} busy={checkpoints.isFetching} nextCursor={checkpoints.data?.nextCursor} onNext={cursor => { selectCheckpoint(undefined); paging.next(cursor); }} onPrevious={() => { selectCheckpoint(undefined); paging.previous(); }} onLatest={() => { selectCheckpoint(undefined); paging.latest(); }} /> : null}
      {expanded && detail.isPending ? <p role="status">{t('logs.loadingDetail')}</p> : expanded && detail.error ? <div><ErrorNotice error={detail.error} /><Button variant="outline" onClick={() => void detail.refetch()}>{t('common.retry')}</Button></div> : entry ? <RuntimeCheckpoint key={entry.id} entry={entry} admin={admin} loadContent={async signal => {
        const event = await getRuntimeEvent(entry.id, signal, true);
        if (event.requestId !== requestId || (guardrailId && event.guardrailId !== guardrailId)) throw new Error(t('logs.checkpointMismatch'));
        return runtimeLogInteractions([event], { includeUncaptured: true })[0]!.entries[0]!;
      }} /> : !checkpoints.isPending && !checkpoints.error && !expanded ? <EmptyState title={t('logs.recordUnavailable')} description={t('logs.recordUnavailableDescription')} /> : null}
    </div>
  </EntitySheet>;
}

export function RuntimeCheckpoint({ entry, admin, loadContent }: { entry: RuntimeLogEntry; admin: boolean; loadContent?: (signal: AbortSignal) => Promise<RuntimeLogEntry> }) {
  const { t } = useTranslation();
  const Icon = entry.phase === "input" ? ArrowDownToLine : ArrowUpFromLine;
  return <section className="overflow-hidden rounded-lg border"><header className="flex flex-wrap items-center gap-3 border-b bg-muted/25 px-4 py-3"><span className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary"><Icon className="size-4" /></span><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{t(entry.phase === "input" ? "logs.inboundCheckpoint" : "logs.outboundCheckpoint")}</h3><p className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground">{entry.trace_id}</p></div><StateBadge state={entry.outcome} /><span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground"><Clock3 className="size-3" />{entry.latency_ms} ms</span></header>
    <div className="grid gap-4 p-4">
      {admin ? <RuntimeContentPanel title={t(entry.phase === "output" ? "logs.modelOutput" : "logs.requestContent")} description={t(entry.phase === "output" ? "logs.modelOutputDescription" : "logs.requestContentDescription")} blocks={entry.content_before} available={entry.content_available} httpRequest={entry.phase === "input" ? entry.http_request : undefined} downloadId={entry.phase === "input" ? entry.id : undefined} collapsible={entry.phase === "input" || Boolean(loadContent)} loadContent={loadContent ? async signal => {
        const content = await loadContent(signal);
        return { blocks: content.content_before, httpRequest: content.phase === "input" ? content.http_request : null, available: content.content_available };
      } : undefined} /> : null}
      {admin && entry.outcome === "transform" ? <RuntimeContentPanel title={t("logs.transformedContent")} description={t("logs.transformedDescription")} blocks={entry.content_after} available={entry.content_available} transformed collapsible={Boolean(loadContent)} loadContent={loadContent ? async signal => {
        const content = await loadContent(signal);
        return { blocks: content.content_after, available: content.content_available };
      } : undefined} /> : null}
      <p className="text-xs leading-5 text-muted-foreground">{entry.detail}</p>
      {entry.findings.length ? <div><h4 className="text-xs font-semibold">{t("logs.findings")}</h4><div className="mt-2 grid gap-2">{entry.findings.map((finding) => <div key={finding.id} className="rounded-md border p-3 text-xs"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{finding.severity}</Badge><strong>{finding.policy_id ?? finding.risk}</strong>{finding.rule_id ? <code className="text-[10px] text-muted-foreground">{finding.rule_id}</code> : null}</div><p className="mt-2 leading-5 text-muted-foreground">{finding.detail}</p></div>)}</div></div> : null}
      <ExecutionTrace steps={entry.steps} />
    </div>
  </section>;
}

function Fact({ label, value }: { label: string; value: string }) { return <div className="border-b p-4 last:border-b-0 sm:border-r sm:[&:nth-child(even)]:border-r-0 sm:[&:nth-last-child(-n+2)]:border-b-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-all text-sm font-medium">{value}</dd></div>; }
