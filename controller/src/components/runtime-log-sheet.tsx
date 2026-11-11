import { ModelCallStatus } from "./model-call-status";
import { RuntimeModelEvidence } from "./runtime-model-evidence";
import { RuntimeErrorDetails } from "@/components/runtime-error-details";
import { RuntimeOutcomeBadge } from "@/components/runtime-outcome-badge";
import { SecuritySeverityBadge } from "@/components/security-severity";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, Clock3, LockKeyhole, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EntitySheet } from "@/components/entity-sheet";
import { EventPagination, useEventCursor } from "@/components/event-pagination";
import { EmptyState, ErrorNotice } from "@/components/product-shell";
import { RuntimeContentPanel } from "@/components/runtime-content-panel";
import { ExecutionTrace } from "@/components/execution-trace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getRuntimeEvent, listRuntimeEvents } from "@/lib/controller-api";
import { runtimeLogInteractions, type RuntimeLogEntry } from "@/lib/api";
import { createLogTimeFormatter } from "@/lib/log-time";

export function RuntimeLogSheet({ requestId, guardrailId, checkpointId, onCheckpointChange, canViewContent, guardrailName, routerName, open, onOpenChange }: {
  requestId?: string; guardrailId?: string; checkpointId?: string;
  onCheckpointChange?: (id?: string) => void;
  canViewContent: boolean; guardrailName: (id: string | null) => string;
  routerName: (id: string | null) => string;
  open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const timeFormatter = useMemo(() => createLogTimeFormatter(i18n.language), [i18n.language]);
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
  const interaction = detail.data ?? runtimeLogInteractions(checkpoints.data?.items ?? [], { includeUncaptured: true })[0];
  const entry = detail.data?.entries[0];
  return <EntitySheet open={open} onOpenChange={onOpenChange} eyebrow={t("logs.interactionDetailEyebrow")} title={t("logs.detailTitle")} description={<span className="break-all font-mono text-xs">{requestId}</span>} width="xl" footer={<Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>}>
    <div className="grid gap-5">
      {interaction ? <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-b pb-5"><Fact label={t("logs.time")} value={timeFormatter.format(new Date(interaction.created_at))} /><Fact label={t("logs.context")} value={`${routerName(interaction.router_id)} · ${interaction.protocol}`} /><div className="col-span-2"><Fact label={t("logs.guardrail")} value={<>{guardrailName(interaction.guardrail_id)}{interaction.guardrail_version ? <span className="ml-2 font-mono text-xs text-muted-foreground">{interaction.guardrail_version}</span> : null}</>} /></div></dl> : null}
      {!canViewContent && entry?.content_available ? <div className="flex gap-3 rounded-lg border bg-muted/25 p-4"><LockKeyhole className="mt-0.5 size-4 shrink-0" /><div><p className="text-sm font-medium">{t("logs.restrictedContentTitle")}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("logs.restrictedContentDescription")}</p></div></div> : null}
      {checkpoints.isPending && !expanded ? <p role="status">{t('logs.loadingDetail')}</p> : checkpoints.error ? <div><ErrorNotice error={checkpoints.error} /><Button variant="outline" onClick={() => void checkpoints.refetch()}>{t('common.retry')}</Button></div> : null}
      {(checkpoints.data?.items.length ?? 0) > 1 ? <div className="grid divide-y border-y">{checkpoints.data?.items.map(event => <button type="button" key={event.id} className={`grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-l-2 px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-ring ${expanded === event.id ? "border-l-primary bg-muted" : "border-l-transparent hover:bg-muted/50"}`} onClick={() => selectCheckpoint(event.id)} aria-pressed={expanded === event.id}>
        <span className="text-sm font-medium">{t(event.direction === 'completion' ? 'logs.callCompletion' : event.direction === 'incoming' ? 'logs.inboundCheckpoint' : 'logs.outboundCheckpoint')}</span>
        <time className="text-xs tabular-nums text-muted-foreground" dateTime={event.occurredAt}>{timeFormatter.format(new Date(event.occurredAt))}</time>
        <span className="col-span-2 mt-1 break-all font-mono text-xs text-muted-foreground">{event.id}</span>
      </button>)}</div> : null}
      {paging.page > 1 || checkpoints.data?.nextCursor ? <EventPagination page={paging.page} busy={checkpoints.isFetching} nextCursor={checkpoints.data?.nextCursor} onNext={cursor => { selectCheckpoint(undefined); paging.next(cursor); }} onPrevious={() => { selectCheckpoint(undefined); paging.previous(); }} onLatest={() => { selectCheckpoint(undefined); paging.latest(); }} /> : null}
      {expanded && detail.isPending ? <p role="status">{t('logs.loadingDetail')}</p> : expanded && detail.error ? <div><ErrorNotice error={detail.error} /><Button variant="outline" onClick={() => void detail.refetch()}>{t('common.retry')}</Button></div> : entry ? <RuntimeCheckpoint key={entry.id} entry={entry} requestId={requestId} canViewContent={canViewContent} loadContent={async signal => {
        const event = await getRuntimeEvent(entry.id, signal, true);
        if (event.requestId !== requestId || (guardrailId && event.guardrailId !== guardrailId)) throw new Error(t('logs.checkpointMismatch'));
        return runtimeLogInteractions([event], { includeUncaptured: true })[0]!.entries[0]!;
      }} /> : !checkpoints.isPending && !checkpoints.error && !expanded ? <EmptyState title={t('logs.recordUnavailable')} description={t('logs.recordUnavailableDescription')} /> : null}
    </div>
  </EntitySheet>;
}

export function RuntimeCheckpoint({ entry, requestId, canViewContent, loadContent }: { entry: RuntimeLogEntry; requestId?: string; canViewContent: boolean; loadContent?: (signal: AbortSignal) => Promise<RuntimeLogEntry> }) {
  const { t } = useTranslation();
  const Icon = entry.phase === "completion" ? Clock3 : entry.phase === "input" ? ArrowDownToLine : ArrowUpFromLine;
  return <section className="overflow-hidden rounded-lg border"><header className="flex flex-wrap items-center gap-3 border-b bg-muted/25 px-4 py-3"><span className="grid size-8 shrink-0 place-items-center text-muted-foreground"><Icon className="size-4" /></span><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{t(entry.phase === "completion" ? "logs.callCompletion" : entry.phase === "input" ? "logs.inboundCheckpoint" : "logs.outboundCheckpoint")}</h3>{entry.trace_id !== requestId ? <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{entry.trace_id}</p> : null}</div><Badge variant="outline">{t(`states.${entry.protection_mode ?? "enforce"}`)}</Badge><RuntimeOutcomeBadge outcome={entry.outcome} executionError={entry.execution_status === "error"} /><span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground"><Clock3 className="size-3" />{entry.latency_ms} ms</span></header>
    <div className="grid gap-4 p-4">
      <ModelCallStatus status={entry.model_status} /><RuntimeErrorDetails entry={entry} />
      <RuntimeModelEvidence entry={entry} canViewContent={canViewContent} loadContent={loadContent} />
      {canViewContent && entry.phase !== "completion" ? <RuntimeContentPanel title={t(entry.phase === "output" ? "logs.modelOutput" : "logs.requestContent")} description={t(entry.phase === "output" ? "logs.modelOutputDescription" : "logs.requestContentDescription")} blocks={entry.content_before} available={entry.content_available} httpRequest={entry.phase === "input" ? entry.http_request : undefined} downloadId={entry.phase === "input" ? entry.id : undefined} collapsible={entry.phase === "input" || Boolean(loadContent)} loadContent={loadContent ? async signal => {
        const content = await loadContent(signal);
        return { blocks: content.content_before, httpRequest: content.phase === "input" ? content.http_request : null, available: content.content_available };
      } : undefined} /> : null}
      {canViewContent && entry.outcome === "transform" && !entry.original_content_only ? <RuntimeContentPanel title={t("logs.transformedContent")} description={t("logs.transformedDescription")} blocks={entry.content_after} available={entry.content_available} transformed collapsible={Boolean(loadContent)} loadContent={loadContent ? async signal => {
        const content = await loadContent(signal);
        return { blocks: content.content_after, available: content.content_available };
      } : undefined} /> : null}
      {entry.phase !== "completion" && entry.detail ? <details className="group"><summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"><ChevronRight aria-hidden className="size-4 shrink-0 group-open:rotate-90" />{t("logs.checkpointDetail")}</summary><p className="pb-2 pl-6 text-xs leading-5 text-muted-foreground">{entry.detail}</p></details> : null}
      {entry.protection_mode === "bypass" ? <p className="text-sm text-muted-foreground">{t("protectionMode.descriptions.bypass")}</p> : null}
      {entry.protection_mode === "monitor" ? <p className="text-sm text-muted-foreground">{t("protectionMode.observation", { result: entry.detection_error ?? t(`logs.outcomes.${entry.detection_decision ?? "unknown"}`, { defaultValue: entry.detection_decision ?? "—" }) })}</p> : null}
      {entry.findings.length ? <div><h4 className="text-xs font-semibold">{t("logs.findings")}</h4><div className="mt-2 grid gap-2">{entry.findings.map((finding) => <div key={finding.id} className="border-b py-3 text-xs last:border-b-0"><div className="flex flex-wrap items-center gap-2"><SecuritySeverityBadge severity={finding.severity} /><Badge variant="outline">{t("securityEvents.requestedAction")}: {t(`securityEvents.actions.${finding.recommended_action}`, { defaultValue: finding.recommended_action })}</Badge><strong className="min-w-0 break-words text-sm [overflow-wrap:anywhere]">{finding.policy_id ?? finding.risk}</strong></div>{finding.rule_id ? <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{finding.rule_id}</p> : null}<dl className="mt-3 grid grid-cols-2 gap-4"><Fact label={t("guardrails.confidenceLabel")} value={finding.confidence === null ? t("securityEvents.notProvided") : `${Math.round(finding.confidence * 100)}%`} /><Fact label={t("securityEvents.policyVersion")} value={finding.policy_version ?? t("securityEvents.notProvided")} /></dl></div>)}</div></div> : null}
      {entry.phase !== "completion" ? <ExecutionTrace steps={entry.steps} /> : null}
    </div>
  </section>;
}

function Fact({ label, value }: { label: string; value: ReactNode }) { return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-sm font-medium [overflow-wrap:anywhere]">{value}</dd></div>; }
