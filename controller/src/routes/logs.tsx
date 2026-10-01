import { runtimeLogOutcomes, type RuntimeLogOutcome } from "../../shared/runtime-outcome";
import { Table as CarbonTable, TableHead as CarbonTableHead, TableBody as CarbonTableBody, TableRow as CarbonTableRow, TableHeader as CarbonTableHeader, TableCell as CarbonTableCell } from "@carbon/react";
import { RuntimeOutcomeBadge } from "@/components/runtime-outcome-badge";
import { RuntimeLogSheet } from "@/components/runtime-log-sheet";
import { LogTimeRangeFields, useLogTimeRange, type LogTimePreset } from "@/components/log-time-range";
import { useSearch, useNavigate, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  Clock3,
  ArrowUpFromLine,
  Filter,
  ScrollText,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { EventPagination, useEventCursor } from '@/components/event-pagination';
import { EmptyState, ErrorNotice, PageHeader } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { queryKeys } from "@/features/query-keys";
import { useAuth } from "@/lib/auth";
import { getRuntimeEvent, listRuntimeEvents } from "@/lib/controller-api";
import {
  getRouters,
  getGuardrailLoggingSettings,
  getGuardrails,
  metricWindowMilliseconds,
  runtimeLogInteractions,
  type MetricWindow,
  type RuntimeLogInteraction,
} from "@/lib/api";

type PhaseFilter = "all" | "input" | "output";
type OutcomeFilter = "all" | RuntimeLogOutcome;

export function LogsPage() {
  const { t: uiText } = useTranslation();
  const { t } = useTranslation();
  const search = useSearch({ from: "/logs" });
  const navigate = useNavigate({ from: "/logs" });
  const { requestId, checkpointId, eventId, outcome: selectedOutcome, guardrailId: selectedGuardrail, ...routingFilters } = search;
  const guardrailId = selectedGuardrail ?? "all";
  const setGuardrailId = (id: string) => void navigate({ search: previous => ({ ...previous, guardrailId: id === "all" ? undefined : id }) });
  const inspect = (interaction: RuntimeLogInteraction, entryId = interaction.entries[0]?.id) => void navigate({
    search: previous => ({ ...previous, requestId: interaction.id, guardrailId: interaction.guardrail_id ?? undefined, checkpointId: entryId }),
  });
  const timeRange = useLogTimeRange(routingFilters, bounds => void navigate({ search: previous => ({ ...previous, ...bounds }) }));
  const { window } = timeRange;
  const [phase, setPhase] = useState<PhaseFilter>("all");
  const outcome = selectedOutcome ?? "all";
  const setOutcome = (value: OutcomeFilter) => void navigate({ search: previous => ({ ...previous, outcome: value === "all" ? undefined : value }) });
  const auth = useAuth();
  const guardrailsQuery = useQuery({ queryKey: queryKeys.guardrails, queryFn: getGuardrails });
  const routersQuery = useQuery({ queryKey: queryKeys.routers, queryFn: getRouters });
  const scopedGuardrailId = guardrailId === "all" ? undefined : guardrailId;
  const paging = useEventCursor(JSON.stringify([guardrailId, window, phase, outcome, routingFilters, eventId]));
  const eventsQuery = useQuery({
    queryKey: [...queryKeys.runtimeEventsScope({ guardrailId: scopedGuardrailId, window, limit: 100 }), phase, outcome, routingFilters, eventId, paging.cursor ?? null],
    queryFn: async ({ signal }) => {
      // An exact event link must also resolve records outside the default time window.
      if (eventId) {
        const event = await getRuntimeEvent(eventId, signal);
        return { items: scopedGuardrailId && event.guardrailId !== scopedGuardrailId ? [] : [event], nextCursor: null };
      }
      return listRuntimeEvents(100, {
        guardrailId: scopedGuardrailId,
        since: new Date(Date.now() - metricWindowMilliseconds(window)).toISOString(),
        ...routingFilters,
        ...(paging.cursor ? { cursor: paging.cursor } : {}),
        ...(phase === 'all' ? {} : { direction: phase === 'input' ? 'incoming' : 'outgoing' }),
        ...(outcome === 'all' ? {} : { outcome }),
      }, signal);
    },
    refetchInterval: paging.page === 1 && !timeRange.fixed ? 15_000 : false,
    refetchOnWindowFocus: false,
    gcTime: 30_000,
  });
  const settingsQuery = useQuery({
    queryKey: queryKeys.guardrailLogging(scopedGuardrailId ?? ""),
    queryFn: () => getGuardrailLoggingSettings(scopedGuardrailId!),
    enabled: Boolean(scopedGuardrailId),
  });
  const runtimeEvents = eventsQuery.data?.items ?? [];
  // A row represents one event; do not borrow context/version from a later checkpoint.
  const interactions = useMemo(() => runtimeEvents.flatMap(event => runtimeLogInteractions([event], {
    includeUncaptured: true,
    phase: phase === "all" ? undefined : phase,
    outcome: outcome === "all" ? undefined : outcome,
  })), [outcome, phase, runtimeEvents]);
  const guardrails = guardrailsQuery.data?.items ?? [];
  const routers = routersQuery.data?.items ?? [];
  const guardrailName = (id: string | null) => guardrails.find((item) => item.id === id)?.name ?? id ?? "—";
  const routerName = (id: string | null) => routers.find((item) => item.id === id)?.name ?? id ?? t("logs.directRuntime");

  return (
    <section className="py-8">
      <PageHeader title={t("pages.logs.title")} description={t("logs.description")} />
      {routingFilters.routerId && <div className="my-3 rounded border p-3 text-sm">{uiText("uiCopy.router")}{" "}{routingFilters.routerId}{" "}{uiText("uiCopy.route")}{" "}{routingFilters.routeId ?? "—"}{" "}{uiText("uiCopy.target")}{" "}{routingFilters.targetId ?? "—"} · r{routingFilters.routerRevision ?? "—"} · {routingFilters.since} – {routingFilters.until} <Link to="/logs" search={{}} className="ml-3 text-primary">{uiText("uiCopy.clearRoutingFilters")}</Link></div>}

      {settingsQuery.data && settingsQuery.data.level !== "info" ? (
        <div className="mt-5 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-950">
          <ScrollText className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0"><p className="text-sm font-semibold">{t("logs.elevatedTitle", { level: settingsQuery.data.level.toUpperCase() })}</p><p className="mt-1 text-xs leading-5 text-amber-900/80">{t("logs.elevatedDescription")}</p></div>
        </div>
      ) : null}

      {eventId ? <div className="mt-5 flex items-center justify-between gap-4 border bg-card px-4 py-2 text-sm">
        <span className="min-w-0 break-all">{t("logs.eventFilter")}: <code className="text-xs">{eventId}</code></span>
        <Button variant="ghost" size="sm" onClick={() => void navigate({ search: previous => ({ ...previous, eventId: undefined, requestId: undefined, checkpointId: undefined }), replace: true })}>{t("logs.clearEventFilter")}</Button>
      </div> : null}
      <Card className="mt-5 gap-0 p-0 shadow-none">
        <div className="grid grid-cols-4 gap-3 p-4">
          <LogFilter label={t("logs.guardrailFilter")}>
            <Select value={guardrailId} onValueChange={setGuardrailId}><SelectTrigger className="field:min-h-11"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("logs.allGuardrails")}</SelectItem>{guardrails.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select>
          </LogFilter>
          <LogFilter label={t("logs.windowFilter")}>
            <Select value={eventId ? "exact" : timeRange.preset} disabled={Boolean(eventId)} onValueChange={value => timeRange.choosePreset(value as LogTimePreset)}><SelectTrigger className="field:min-h-11"><SelectValue /></SelectTrigger><SelectContent>{eventId ? <SelectItem value="exact">{t("logs.allTime")}</SelectItem> : null}{(["1h", "24h", "7d", "15d", "30d"] as MetricWindow[]).map((value) => <SelectItem key={value} value={value}>{t(`dashboard.windows.${value}`)}</SelectItem>)}<SelectItem value="custom">{t("logs.customTimeRange")}</SelectItem></SelectContent></Select>
          </LogFilter>
          <LogFilter label={t("logs.directionFilter")}>
            <Select value={phase} onValueChange={(value) => setPhase(value as PhaseFilter)}><SelectTrigger className="field:min-h-11"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("logs.allDirections")}</SelectItem><SelectItem value="input">{t("logs.inbound")}</SelectItem><SelectItem value="output">{t("logs.outbound")}</SelectItem></SelectContent></Select>
          </LogFilter>
          <LogFilter label={t("logs.outcomeFilter")}>
            <Select value={outcome} onValueChange={(value) => setOutcome(value as OutcomeFilter)}><SelectTrigger className="field:min-h-11"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("logs.allOutcomes")}</SelectItem>{runtimeLogOutcomes.map((value) => <SelectItem key={value} value={value}>{t(value === "error" ? "logs.executionErrorOutcome" : `logs.outcomes.${value}`)}</SelectItem>)}</SelectContent></Select>
          </LogFilter>
        </div>
        <LogTimeRangeFields range={timeRange} disabled={Boolean(eventId)} />
      </Card>

      <div className="mt-5">
        <RuntimeHistory
          interactions={interactions}
          loading={eventsQuery.isLoading}
          error={eventsQuery.error}
          onRetry={() => void eventsQuery.refetch()}
          onInspect={inspect}
          guardrailName={guardrailName}
          routerName={routerName}
        />
      </div>

      <EventPagination page={paging.page} busy={eventsQuery.isFetching} nextCursor={eventsQuery.data?.nextCursor} onNext={paging.next} onPrevious={paging.previous} onLatest={paging.latest} />
      <p className="mt-2 text-xs text-muted-foreground">{t('eventPagination.checkpointScope')}</p>
      <RuntimeLogSheet
        key={`${requestId}:${selectedGuardrail}`}
        requestId={requestId}
        guardrailId={selectedGuardrail}
        checkpointId={checkpointId}
        onCheckpointChange={id => void navigate({ search: previous => ({ ...previous, checkpointId: id }), replace: true })}
        admin={auth.user?.role === "admin"}
        guardrailName={guardrailName}
        routerName={routerName}
        open={Boolean(requestId)}
        onOpenChange={(open) => { if (!open) void navigate({ search: previous => ({ ...previous, requestId: undefined, checkpointId: undefined }), replace: true }); }}
      />
    </section>
  );
}

function LogFilter({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1.5"><span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Filter className="size-3" />{label}</span>{children}</label>;
}

function Direction({ phases }: { phases: Set<string> }) {
  const { t } = useTranslation();
  if (phases.has("completion")) return <span className="inline-flex items-center gap-1.5"><Clock3 className="size-3.5" />{t("logs.callCompletion")}</span>;
  if (phases.has("input") && phases.has("output")) return <span className="inline-flex items-center gap-1 text-[11px]"><ArrowDownToLine className="size-3 text-primary" /><span aria-hidden>→</span><ArrowUpFromLine className="size-3 text-primary" /><span className="sr-only">{t("logs.bothDirections")}</span></span>;
  if (phases.has("output")) return <span className="inline-flex items-center gap-1.5"><ArrowUpFromLine className="size-3.5 text-primary" />{t("logs.outbound")}</span>;
  return <span className="inline-flex items-center gap-1.5"><ArrowDownToLine className="size-3.5 text-primary" />{t("logs.inbound")}</span>;
}

export function RuntimeHistory({ interactions, loading, error, onRetry, onInspect, guardrailName, routerName }: { interactions: RuntimeLogInteraction[]; loading: boolean; error: unknown; onRetry?: () => void; onInspect: (item: RuntimeLogInteraction, checkpointId?: string) => void; guardrailName: (id: string | null) => string; routerName: (id: string | null) => string }) {
  const { t, i18n } = useTranslation();
  const records = useMemo(() => interactions.flatMap((interaction) => interaction.entries
    .map((entry) => ({ interaction, entry })))
    .sort((left, right) => Date.parse(right.entry.created_at) - Date.parse(left.entry.created_at)), [interactions]);
  if (loading) return <Skeleton className="h-[28rem] rounded-xl" />;
  if (error) return <div><ErrorNotice error={error} />{onRetry && <Button variant="outline" className="mt-3" onClick={onRetry}>{t("common.retry")}</Button>}</div>;
  if (!records.length) return <EmptyState title={t("logs.emptyCheckpointTitle")} description={t("logs.emptyCheckpointDescription")} />;
  return <Card className="gap-0 overflow-hidden p-0 shadow-none">
    <div className="overflow-x-auto"><CarbonTable aria-label={t("pages.logs.title")} className="w-full min-w-[64rem] table-fixed text-left text-xs"><CarbonTableHead className="border-b bg-muted/40 text-muted-foreground"><CarbonTableRow><CarbonTableHeader className="h-10 w-44 px-4 font-medium">{t("logs.time")}</CarbonTableHeader><CarbonTableHeader className="h-10 w-28 px-4 font-medium">{t("logs.direction")}</CarbonTableHeader><CarbonTableHeader className="h-10 w-48 px-4 font-medium">{t("logs.guardrail")}</CarbonTableHeader><CarbonTableHeader className="h-10 w-32 px-4 font-medium">{t("logs.outcome")}</CarbonTableHeader><CarbonTableHeader className="h-10 px-4 font-medium">{t("logs.context")}</CarbonTableHeader><CarbonTableHeader className="h-10 w-24 px-4 text-right font-medium">{t("logs.latency")}</CarbonTableHeader><CarbonTableHeader className="h-10 w-14"><span className="sr-only">{t("logs.inspect")}</span></CarbonTableHeader></CarbonTableRow></CarbonTableHead><CarbonTableBody className="divide-y">{records.map(({ interaction, entry }) => <CarbonTableRow key={entry.id} className="min-h-14 cursor-pointer hover:bg-muted/30" onClick={() => onInspect(interaction, entry.id)}><CarbonTableCell className="px-4 py-3 font-mono text-[11px] text-muted-foreground">{new Date(entry.created_at).toLocaleString(i18n.language, { hour12: false })}</CarbonTableCell><CarbonTableCell className="px-4 py-3"><Direction phases={new Set([entry.phase])} /></CarbonTableCell><CarbonTableCell className="px-4 py-3"><strong className="block truncate text-xs font-medium">{guardrailName(interaction.guardrail_id)}</strong><span className="mt-0.5 block text-[11px] text-muted-foreground">{interaction.guardrail_version ?? "—"}</span></CarbonTableCell><CarbonTableCell className="px-4 py-3"><RuntimeOutcomeBadge outcome={entry.outcome} executionError={entry.execution_status === "error"} /></CarbonTableCell><CarbonTableCell className="px-4 py-3"><p className="truncate">{routerName(interaction.router_id)}</p>{entry.execution_status === "error" && <p className="text-destructive">{t(entry.call_completion?.inferred ? "logs.inferredTimeout" : "securityEvents.runtimeError")}</p>}<p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{interaction.protocol} · {entry.trace_id}</p></CarbonTableCell><CarbonTableCell className="px-4 py-3 text-right font-mono text-[11px] tabular-nums">{entry.latency_ms} ms</CarbonTableCell><CarbonTableCell><Button size="icon" variant="ghost" className="size-11" aria-label={t("logs.inspectCheckpoint", { id: entry.id })} onClick={(event) => { event.stopPropagation(); onInspect(interaction, entry.id); }}><ScrollText className="size-4" /></Button></CarbonTableCell></CarbonTableRow>)}</CarbonTableBody></CarbonTable></div>
  </Card>;
}
