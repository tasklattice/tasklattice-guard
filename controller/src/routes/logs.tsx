import { RuntimeLogSheet } from "@/components/runtime-log-sheet";
import { useSearch, useNavigate, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Filter,
  ScrollText,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { EventPagination, useEventCursor } from '@/components/event-pagination';
import { EmptyState, ErrorNotice, PageHeader, StateBadge } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { queryKeys } from "@/features/query-keys";
import { useAuth } from "@/lib/auth";
import { normalizeOutcome } from "@/lib/controller-api-mappers";
import { listRuntimeEvents, type RuntimeEvent } from "@/lib/controller-api";
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
type OutcomeFilter = "all" | "allow" | "transform" | "block" | "error";
type LogView = "interactions" | "checkpoints" | "system";

export function LogsPage() {
  const { t } = useTranslation();
  const search = useSearch({ from: "/logs" });
  const navigate = useNavigate({ from: "/logs" });
  const { requestId, checkpointId, tab: selectedTab, guardrailId: selectedGuardrail, ...routingFilters } = search;
  const tab = selectedTab ?? "interactions";
  const guardrailId = selectedGuardrail ?? "all";
  const setTab = (tab: LogView) => void navigate({ search: previous => ({ ...previous, tab }) });
  const setGuardrailId = (id: string) => void navigate({ search: previous => ({ ...previous, guardrailId: id === "all" ? undefined : id }) });
  const inspect = (interaction: RuntimeLogInteraction, entryId = interaction.entries[0]?.id) => void navigate({
    search: previous => ({ ...previous, requestId: interaction.id, guardrailId: interaction.guardrail_id, checkpointId: entryId }),
  });
  const [window, setWindow] = useState<MetricWindow>("24h");
  const [phase, setPhase] = useState<PhaseFilter>("all");
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const auth = useAuth();
  const guardrailsQuery = useQuery({ queryKey: queryKeys.guardrails, queryFn: getGuardrails });
  const routersQuery = useQuery({ queryKey: queryKeys.routers, queryFn: getRouters });
  const scopedGuardrailId = guardrailId === "all" ? undefined : guardrailId;
  const paging = useEventCursor(JSON.stringify([guardrailId, window, phase, outcome, tab, routingFilters]));
  const eventsQuery = useQuery({
    queryKey: [...queryKeys.runtimeEventsScope({ guardrailId: scopedGuardrailId, window, limit: 100 }), phase, outcome, tab, routingFilters, paging.cursor ?? null],
    queryFn: ({ signal }) => listRuntimeEvents(100, {
      guardrailId: scopedGuardrailId,
      since: new Date(Date.now() - metricWindowMilliseconds(window)).toISOString(),
      ...routingFilters,
      ...(paging.cursor ? { cursor: paging.cursor } : {}),
      ...(phase === 'all' ? {} : { direction: phase === 'input' ? 'incoming' : 'outgoing' }),
      ...(outcome === 'all' ? {} : { outcome }),
      ...(tab === 'system' ? {} : { captured: 'true' }),
    }, signal),
    refetchInterval: paging.page === 1 ? 15_000 : false,
    refetchOnWindowFocus: false,
    gcTime: 30_000,
  });
  const settingsQuery = useQuery({
    queryKey: queryKeys.guardrailLogging(scopedGuardrailId ?? ""),
    queryFn: () => getGuardrailLoggingSettings(scopedGuardrailId!),
    enabled: Boolean(scopedGuardrailId),
  });
  const runtimeEvents = eventsQuery.data?.items ?? [];
  const interactions = useMemo(() => runtimeLogInteractions(runtimeEvents, {
    phase: phase === "all" ? undefined : phase,
    outcome: outcome === "all" ? undefined : outcome,
  }), [outcome, phase, runtimeEvents]);
  const guardrails = guardrailsQuery.data?.items ?? [];
  const routers = routersQuery.data?.items ?? [];
  const guardrailName = (id: string | null) => guardrails.find((item) => item.id === id)?.name ?? id ?? "—";
  const routerName = (id: string | null) => routers.find((item) => item.id === id)?.name ?? id ?? t("logs.directRuntime");

  return (
    <section className="py-6 sm:py-8">
      <PageHeader title={t("pages.logs.title")} description={t("logs.description")} />
      {routingFilters.routerId && <div className="my-3 rounded border p-3 text-sm">Router: {routingFilters.routerId} · Route: {routingFilters.routeId ?? "—"} · Target: {routingFilters.targetId ?? "—"} · r{routingFilters.routerRevision ?? "—"} · {routingFilters.since} – {routingFilters.until} <Link to="/logs" search={{}} className="ml-3 text-primary">Clear routing filters</Link></div>}

      {settingsQuery.data && settingsQuery.data.level !== "info" ? (
        <div className="mt-5 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-950">
          <ScrollText className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0"><p className="text-sm font-semibold">{t("logs.elevatedTitle", { level: settingsQuery.data.level.toUpperCase() })}</p><p className="mt-1 text-xs leading-5 text-amber-900/80">{t("logs.elevatedDescription")}</p></div>
        </div>
      ) : null}

      <Card className="mt-5 gap-0 p-0 shadow-none">
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <LogFilter label={t("logs.guardrailFilter")}>
            <Select value={guardrailId} onValueChange={setGuardrailId}><SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("logs.allGuardrails")}</SelectItem>{guardrails.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select>
          </LogFilter>
          <LogFilter label={t("logs.windowFilter")}>
            <Select value={window} onValueChange={(value) => setWindow(value as MetricWindow)}><SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger><SelectContent>{(["1h", "24h", "7d", "15d", "30d"] as MetricWindow[]).map((value) => <SelectItem key={value} value={value}>{t(`dashboard.windows.${value}`)}</SelectItem>)}</SelectContent></Select>
          </LogFilter>
          <LogFilter label={t("logs.directionFilter")}>
            <Select value={phase} onValueChange={(value) => setPhase(value as PhaseFilter)}><SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("logs.allDirections")}</SelectItem><SelectItem value="input">{t("logs.inbound")}</SelectItem><SelectItem value="output">{t("logs.outbound")}</SelectItem></SelectContent></Select>
          </LogFilter>
          <LogFilter label={t("logs.outcomeFilter")}>
            <Select value={outcome} onValueChange={(value) => setOutcome(value as OutcomeFilter)}><SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("logs.allOutcomes")}</SelectItem>{(["allow", "transform", "block", "error"] as const).map((value) => <SelectItem key={value} value={value}>{t(`logs.outcomes.${value}`)}</SelectItem>)}</SelectContent></Select>
          </LogFilter>
        </div>
      </Card>

      <Tabs value={tab} onValueChange={(value) => setTab(value as LogView)} className="mt-5">
        <TabsList aria-label={t("logs.views")}>
          <TabsTrigger value="interactions">{t("logs.interactions")}</TabsTrigger>
          <TabsTrigger value="checkpoints">{t("logs.checkpoints")}</TabsTrigger>
          <TabsTrigger value="system">{t("logs.systemEvents")}</TabsTrigger>
        </TabsList>
        <TabsContent value="interactions" className="pt-4">
          <InteractionHistory
            interactions={interactions}
            loading={eventsQuery.isLoading}
            error={eventsQuery.error}
            onInspect={inspect}
            guardrailName={guardrailName}
            routerName={routerName}
          />
        </TabsContent>
        <TabsContent value="checkpoints" className="pt-4">
          <CheckpointHistory
            interactions={interactions}
            loading={eventsQuery.isLoading}
            error={eventsQuery.error}
            onInspect={inspect}
            guardrailName={guardrailName}
            routerName={routerName}
          />
        </TabsContent>
        <TabsContent value="system" className="pt-4">
          <SystemEventHistory
            events={runtimeEvents}
            phase={phase}
            outcome={outcome}
            loading={eventsQuery.isLoading}
            error={eventsQuery.error}
            guardrailName={guardrailName}
            routerName={routerName}
          />
        </TabsContent>
      </Tabs>

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

function InteractionHistory({ interactions, loading, error, onInspect, guardrailName, routerName }: { interactions: RuntimeLogInteraction[]; loading: boolean; error: unknown; onInspect: (item: RuntimeLogInteraction, checkpointId?: string) => void; guardrailName: (id: string | null) => string; routerName: (id: string | null) => string }) {
  const { t, i18n } = useTranslation();
  if (loading) return <Skeleton className="h-[30rem] rounded-xl" />;
  if (error) return <ErrorNotice error={error} />;
  if (!interactions.length) return <EmptyState title={t("logs.emptyInteractionTitle")} description={t("logs.emptyInteractionDescription")} />;
  return <Card className="gap-0 overflow-hidden p-0 shadow-none">
    <div className="overflow-x-auto"><table className="w-full min-w-[58rem] table-fixed text-left text-xs"><thead className="border-b bg-muted/40 text-muted-foreground"><tr><th className="h-10 w-44 px-4 font-medium">{t("logs.time")}</th><th className="h-10 w-52 px-4 font-medium">{t("logs.guardrail")}</th><th className="h-10 w-28 px-4 font-medium">{t("logs.direction")}</th><th className="h-10 w-28 px-4 font-medium">{t("logs.outcome")}</th><th className="h-10 px-4 font-medium">{t("logs.context")}</th><th className="h-10 w-24 px-4 text-right font-medium">{t("logs.latency")}</th><th className="h-10 w-14"><span className="sr-only">{t("logs.inspect")}</span></th></tr></thead>
    <tbody className="divide-y">{interactions.map((item) => { const phases = new Set(item.entries.map((entry) => entry.phase)); const latency = item.entries.reduce((sum, entry) => sum + entry.latency_ms, 0); return <tr key={`${item.id}:${item.guardrail_id}`} className="h-14 cursor-pointer hover:bg-muted/30" onClick={() => onInspect(item)}><td className="px-4 font-mono text-[11px] tabular-nums text-muted-foreground">{new Date(item.created_at).toLocaleString(i18n.language)}</td><td className="px-4"><strong className="block truncate text-xs font-medium">{guardrailName(item.guardrail_id)}</strong><span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{t("logs.version", { version: item.guardrail_version ?? "—" })}</span></td><td className="px-4"><Direction phases={phases} /></td><td className="px-4"><StateBadge state={item.outcome} /></td><td className="truncate px-4"><span className="block truncate">{routerName(item.router_id)}</span><span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{item.protocol} · {item.id}</span></td><td className="px-4 text-right font-mono text-[11px] tabular-nums">{latency} ms</td><td><Button size="icon" variant="ghost" className="size-11" aria-label={t("logs.inspectRecord", { id: item.id })} onClick={(event) => { event.stopPropagation(); onInspect(item); }}><ScrollText className="size-4" /></Button></td></tr>; })}</tbody></table></div>
  </Card>;
}

function Direction({ phases }: { phases: Set<string> }) {
  const { t } = useTranslation();
  if (phases.has("input") && phases.has("output")) return <span className="inline-flex items-center gap-1 text-[11px]"><ArrowDownToLine className="size-3 text-primary" /><span aria-hidden>→</span><ArrowUpFromLine className="size-3 text-primary" /><span className="sr-only">{t("logs.bothDirections")}</span></span>;
  if (phases.has("output")) return <span className="inline-flex items-center gap-1.5"><ArrowUpFromLine className="size-3.5 text-primary" />{t("logs.outbound")}</span>;
  return <span className="inline-flex items-center gap-1.5"><ArrowDownToLine className="size-3.5 text-primary" />{t("logs.inbound")}</span>;
}

export function CheckpointHistory({ interactions, loading, error, onInspect, guardrailName, routerName }: { interactions: RuntimeLogInteraction[]; loading: boolean; error: unknown; onInspect: (item: RuntimeLogInteraction, checkpointId?: string) => void; guardrailName: (id: string | null) => string; routerName: (id: string | null) => string }) {
  const { t, i18n } = useTranslation();
  const records = useMemo(() => interactions.flatMap((interaction) => interaction.entries
    .map((entry) => ({ interaction, entry })))
    .sort((left, right) => Date.parse(right.entry.created_at) - Date.parse(left.entry.created_at)), [interactions]);
  if (loading) return <Skeleton className="h-[28rem] rounded-xl" />;
  if (error) return <ErrorNotice error={error} />;
  if (!records.length) return <EmptyState title={t("logs.emptyCheckpointTitle")} description={t("logs.emptyCheckpointDescription")} />;
  return <Card className="gap-0 overflow-hidden p-0 shadow-none">
    <div className="border-b px-4 py-3"><p className="text-xs font-semibold">{t("logs.checkpointTitle")}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("logs.checkpointDescription")}</p></div>
    <div className="overflow-x-auto"><table className="w-full min-w-[64rem] table-fixed text-left text-xs"><thead className="border-b bg-muted/40 text-muted-foreground"><tr><th className="h-10 w-44 px-4 font-medium">{t("logs.time")}</th><th className="h-10 w-28 px-4 font-medium">{t("logs.direction")}</th><th className="h-10 w-48 px-4 font-medium">{t("logs.guardrail")}</th><th className="h-10 w-28 px-4 font-medium">{t("logs.outcome")}</th><th className="h-10 px-4 font-medium">{t("logs.checkpointDetail")}</th><th className="h-10 w-24 px-4 text-right font-medium">{t("logs.latency")}</th><th className="h-10 w-14"><span className="sr-only">{t("logs.inspect")}</span></th></tr></thead><tbody className="divide-y">{records.map(({ interaction, entry }) => <tr key={entry.id} className="min-h-14 cursor-pointer hover:bg-muted/30" onClick={() => onInspect(interaction, entry.id)}><td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">{new Date(entry.created_at).toLocaleString(i18n.language)}</td><td className="px-4 py-3"><Direction phases={new Set([entry.phase])} /></td><td className="px-4 py-3"><strong className="block truncate text-xs font-medium">{guardrailName(interaction.guardrail_id)}</strong><span className="mt-0.5 block text-[11px] text-muted-foreground">{t("logs.version", { version: interaction.guardrail_version ?? "—" })}</span></td><td className="px-4 py-3"><StateBadge state={entry.outcome} /></td><td className="px-4 py-3"><p className="leading-5">{entry.detail}</p><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{routerName(interaction.router_id)} · {interaction.protocol} · {entry.trace_id}</p></td><td className="px-4 py-3 text-right font-mono text-[11px] tabular-nums">{entry.latency_ms} ms</td><td><Button size="icon" variant="ghost" className="size-11" aria-label={t("logs.inspectCheckpoint", { id: entry.id })} onClick={(event) => { event.stopPropagation(); onInspect(interaction, entry.id); }}><ScrollText className="size-4" /></Button></td></tr>)}</tbody></table></div>
  </Card>;
}

function SystemEventHistory({ events, phase, outcome, loading, error, guardrailName, routerName }: { events: RuntimeEvent[]; phase: PhaseFilter; outcome: OutcomeFilter; loading: boolean; error: unknown; guardrailName: (id: string | null) => string; routerName: (id: string | null) => string }) {
  const { t, i18n } = useTranslation();
  const filtered = useMemo(() => events
    .filter((event) => phase === "all" || event.direction === (phase === "input" ? "incoming" : "outgoing"))
    .filter((event) => outcome === "all" || normalizeOutcome(event.decision) === outcome)
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt)), [events, outcome, phase]);
  if (loading) return <Skeleton className="h-[28rem] rounded-xl" />;
  if (error) return <ErrorNotice error={error} />;
  if (!filtered.length) return <EmptyState title={t("logs.emptySystemTitle")} description={t("logs.emptySystemDescription")} />;
  return <Card className="gap-0 overflow-hidden p-0 shadow-none">
    <div className="border-b px-4 py-3"><p className="text-xs font-semibold">{t("logs.systemEventTitle")}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("logs.systemEventDescription")}</p></div>
    <div className="divide-y xl:hidden">{filtered.map((event) => <article key={event.id} className="p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{guardrailName(event.guardrailId)}</p><p className="mt-1 font-mono text-[11px] text-muted-foreground">{new Date(event.occurredAt).toLocaleString(i18n.language)}</p></div><StateBadge state={event.decision} /></div><dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs"><RuntimeFact label={t("logs.runner")} value={event.runnerId} /><RuntimeFact label={t("logs.direction")} value={t(event.direction === "incoming" ? "logs.inbound" : "logs.outbound")} /><RuntimeFact label={t("logs.context")} value={routerName(event.routerId)} /><RuntimeFact label={t("logs.latency")} value={`${event.durationMs} ms`} /></dl></article>)}</div>
    <div className="hidden overflow-x-auto xl:block"><table className="w-full min-w-[68rem] table-fixed text-left text-xs"><thead className="border-b bg-muted/40 text-muted-foreground"><tr><th className="h-10 w-44 px-4 font-medium">{t("logs.time")}</th><th className="h-10 w-48 px-4 font-medium">{t("logs.guardrail")}</th><th className="h-10 w-32 px-4 font-medium">{t("logs.runner")}</th><th className="h-10 w-28 px-4 font-medium">{t("logs.direction")}</th><th className="h-10 w-28 px-4 font-medium">{t("logs.outcome")}</th><th className="h-10 px-4 font-medium">{t("logs.context")}</th><th className="h-10 w-24 px-4 text-right font-medium">{t("logs.latency")}</th></tr></thead><tbody className="divide-y">{filtered.map((event) => <tr key={event.id} className="h-14 hover:bg-muted/30"><td className="px-4 font-mono text-[11px] text-muted-foreground">{new Date(event.occurredAt).toLocaleString(i18n.language)}</td><td className="px-4"><strong className="block truncate text-xs font-medium">{guardrailName(event.guardrailId)}</strong><span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{t("logs.version", { version: event.guardrailVersion ?? "—" })}</span></td><td className="truncate px-4 font-mono text-[11px]">{event.runnerId}</td><td className="px-4">{t(event.direction === "incoming" ? "logs.inbound" : "logs.outbound")}</td><td className="px-4"><StateBadge state={event.decision} /></td><td className="px-4"><span className="block truncate">{routerName(event.routerId)}</span><span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">{event.requestId}</span></td><td className="px-4 text-right font-mono text-[11px] tabular-nums">{event.durationMs} ms</td></tr>)}</tbody></table></div>
  </Card>;
}

function RuntimeFact({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="mt-0.5 truncate font-medium">{value}</dd></div>;
}
