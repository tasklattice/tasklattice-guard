import { useSearch, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Clock3,
  ChevronRight,
  FileCode2,
  Filter,
  LockKeyhole,
  ScrollText,
  Workflow,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { EntitySheet } from "@/components/entity-sheet";
import { EventPagination, useEventCursor } from '@/components/event-pagination';
import { EmptyState, ErrorNotice, PageHeader, StateBadge } from "@/components/product-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { queryKeys } from "@/features/query-keys";
import { useAuth } from "@/lib/auth";
import { normalizeOutcome } from "@/lib/controller-api-mappers";
import { getRuntimeEvent, listRuntimeEvents, type RuntimeEvent } from "@/lib/controller-api";
import {
  getRouters,
  getGuardrailLoggingSettings,
  getGuardrails,
  metricWindowMilliseconds,
  runtimeLogInteractions,
  type RouterTraceStep,
  type MetricWindow,
  type RuntimeLogContentBlock,
  type RuntimeLogEntry,
  type RuntimeLogInteraction,
} from "@/lib/api";

type PhaseFilter = "all" | "input" | "output";
type OutcomeFilter = "all" | "allow" | "transform" | "block" | "error";
type LogView = "interactions" | "checkpoints" | "system";

export function LogsPage() {
  const { t } = useTranslation();
  const routingFilters = useSearch({ from: "/logs" });
  const [tab, setTab] = useState<LogView>("interactions");
  const [guardrailId, setGuardrailId] = useState("all");
  const [window, setWindow] = useState<MetricWindow>("24h");
  const [phase, setPhase] = useState<PhaseFilter>("all");
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [selected, setSelected] = useState<RuntimeLogInteraction | null>(null);
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
            onInspect={setSelected}
            guardrailName={guardrailName}
            routerName={routerName}
          />
        </TabsContent>
        <TabsContent value="checkpoints" className="pt-4">
          <CheckpointHistory
            interactions={interactions}
            loading={eventsQuery.isLoading}
            error={eventsQuery.error}
            onInspect={setSelected}
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
        key={`${selected?.id}:${selected?.guardrail_id}`}
        interaction={selected}
        admin={auth.user?.role === "admin"}
        guardrailName={guardrailName}
        routerName={routerName}
        open={Boolean(selected)}
        onOpenChange={(open) => { if (!open) setSelected(null); }}
      />
    </section>
  );
}

function LogFilter({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1.5"><span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Filter className="size-3" />{label}</span>{children}</label>;
}

function InteractionHistory({ interactions, loading, error, onInspect, guardrailName, routerName }: { interactions: RuntimeLogInteraction[]; loading: boolean; error: unknown; onInspect: (item: RuntimeLogInteraction) => void; guardrailName: (id: string | null) => string; routerName: (id: string | null) => string }) {
  const { t, i18n } = useTranslation();
  if (loading) return <Skeleton className="h-[30rem] rounded-xl" />;
  if (error) return <ErrorNotice error={error} />;
  if (!interactions.length) return <EmptyState title={t("logs.emptyInteractionTitle")} description={t("logs.emptyInteractionDescription")} />;
  return <Card className="gap-0 overflow-hidden p-0 shadow-none">
    <div className="overflow-x-auto"><table className="w-full min-w-[58rem] table-fixed text-left text-xs"><thead className="border-b bg-muted/40 text-muted-foreground"><tr><th className="h-10 w-44 px-4 font-medium">{t("logs.time")}</th><th className="h-10 w-52 px-4 font-medium">{t("logs.guardrail")}</th><th className="h-10 w-28 px-4 font-medium">{t("logs.direction")}</th><th className="h-10 w-28 px-4 font-medium">{t("logs.outcome")}</th><th className="h-10 px-4 font-medium">{t("logs.context")}</th><th className="h-10 w-24 px-4 text-right font-medium">{t("logs.latency")}</th><th className="h-10 w-14"><span className="sr-only">{t("logs.inspect")}</span></th></tr></thead>
    <tbody className="divide-y">{interactions.map((item) => { const phases = new Set(item.entries.map((entry) => entry.phase)); const latency = item.entries.reduce((sum, entry) => sum + entry.latency_ms, 0); return <tr key={item.id} className="h-14 hover:bg-muted/30"><td className="px-4 font-mono text-[11px] tabular-nums text-muted-foreground">{new Date(item.created_at).toLocaleString(i18n.language)}</td><td className="px-4"><strong className="block truncate text-xs font-medium">{guardrailName(item.guardrail_id)}</strong><span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{t("logs.version", { version: item.guardrail_version ?? "—" })}</span></td><td className="px-4"><Direction phases={phases} /></td><td className="px-4"><StateBadge state={item.outcome} /></td><td className="truncate px-4"><span className="block truncate">{routerName(item.router_id)}</span><span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{item.protocol} · {item.id}</span></td><td className="px-4 text-right font-mono text-[11px] tabular-nums">{latency} ms</td><td><Button size="icon" variant="ghost" className="size-11" aria-label={t("logs.inspectRecord", { id: item.id })} onClick={() => onInspect(item)}><ScrollText className="size-4" /></Button></td></tr>; })}</tbody></table></div>
  </Card>;
}

function Direction({ phases }: { phases: Set<string> }) {
  const { t } = useTranslation();
  if (phases.has("input") && phases.has("output")) return <span className="inline-flex items-center gap-1 text-[11px]"><ArrowDownToLine className="size-3 text-primary" /><span aria-hidden>→</span><ArrowUpFromLine className="size-3 text-primary" /><span className="sr-only">{t("logs.bothDirections")}</span></span>;
  if (phases.has("output")) return <span className="inline-flex items-center gap-1.5"><ArrowUpFromLine className="size-3.5 text-primary" />{t("logs.outbound")}</span>;
  return <span className="inline-flex items-center gap-1.5"><ArrowDownToLine className="size-3.5 text-primary" />{t("logs.inbound")}</span>;
}

export function CheckpointHistory({ interactions, loading, error, onInspect, guardrailName, routerName }: { interactions: RuntimeLogInteraction[]; loading: boolean; error: unknown; onInspect: (item: RuntimeLogInteraction) => void; guardrailName: (id: string | null) => string; routerName: (id: string | null) => string }) {
  const { t, i18n } = useTranslation();
  const records = useMemo(() => interactions.flatMap((interaction) => interaction.entries
    .map((entry) => ({ interaction, entry })))
    .sort((left, right) => Date.parse(right.entry.created_at) - Date.parse(left.entry.created_at)), [interactions]);
  if (loading) return <Skeleton className="h-[28rem] rounded-xl" />;
  if (error) return <ErrorNotice error={error} />;
  if (!records.length) return <EmptyState title={t("logs.emptyCheckpointTitle")} description={t("logs.emptyCheckpointDescription")} />;
  return <Card className="gap-0 overflow-hidden p-0 shadow-none">
    <div className="border-b px-4 py-3"><p className="text-xs font-semibold">{t("logs.checkpointTitle")}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("logs.checkpointDescription")}</p></div>
    <div className="overflow-x-auto"><table className="w-full min-w-[64rem] table-fixed text-left text-xs"><thead className="border-b bg-muted/40 text-muted-foreground"><tr><th className="h-10 w-44 px-4 font-medium">{t("logs.time")}</th><th className="h-10 w-28 px-4 font-medium">{t("logs.direction")}</th><th className="h-10 w-48 px-4 font-medium">{t("logs.guardrail")}</th><th className="h-10 w-28 px-4 font-medium">{t("logs.outcome")}</th><th className="h-10 px-4 font-medium">{t("logs.checkpointDetail")}</th><th className="h-10 w-24 px-4 text-right font-medium">{t("logs.latency")}</th><th className="h-10 w-14"><span className="sr-only">{t("logs.inspect")}</span></th></tr></thead><tbody className="divide-y">{records.map(({ interaction, entry }) => <tr key={entry.id} className="min-h-14 hover:bg-muted/30"><td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">{new Date(entry.created_at).toLocaleString(i18n.language)}</td><td className="px-4 py-3"><Direction phases={new Set([entry.phase])} /></td><td className="px-4 py-3"><strong className="block truncate text-xs font-medium">{guardrailName(interaction.guardrail_id)}</strong><span className="mt-0.5 block text-[11px] text-muted-foreground">{t("logs.version", { version: interaction.guardrail_version ?? "—" })}</span></td><td className="px-4 py-3"><StateBadge state={entry.outcome} /></td><td className="px-4 py-3"><p className="leading-5">{entry.detail}</p><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{routerName(interaction.router_id)} · {interaction.protocol} · {entry.trace_id}</p></td><td className="px-4 py-3 text-right font-mono text-[11px] tabular-nums">{entry.latency_ms} ms</td><td><Button size="icon" variant="ghost" className="size-11" aria-label={t("logs.inspectCheckpoint", { id: entry.id })} onClick={() => onInspect(interaction)}><ScrollText className="size-4" /></Button></td></tr>)}</tbody></table></div>
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

export function RuntimeLogSheet({ interaction, admin, guardrailName, routerName, open, onOpenChange }: { interaction: RuntimeLogInteraction | null; admin: boolean; guardrailName: (id: string | null) => string; routerName: (id: string | null) => string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const paging = useEventCursor(`${interaction?.id}:${interaction?.guardrail_id}`);
  const [expanded, setExpanded] = useState<string | null>(null);
  const checkpoints = useQuery({
    queryKey: ['interaction-checkpoints', interaction?.id, interaction?.guardrail_id, paging.cursor],
    enabled: open && Boolean(interaction), gcTime: 0, refetchOnWindowFocus: false,
    queryFn: ({ signal }) => listRuntimeEvents(100, { requestId: interaction!.id, guardrailId: interaction!.guardrail_id, captured: 'true', ...(paging.cursor ? { cursor: paging.cursor } : {}) }, signal),
  });
  const detail = useQuery({
    queryKey: ['checkpoint-detail', expanded], enabled: open && Boolean(expanded), gcTime: 0, refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => runtimeLogInteractions([await getRuntimeEvent(expanded!, signal)])[0]?.entries[0] ?? null,
  });
  if (!interaction) return null;
  return <EntitySheet open={open} onOpenChange={onOpenChange} eyebrow={t("logs.interactionDetailEyebrow")} title={t("logs.detailTitle")} description={<span className="break-all font-mono text-xs">{interaction.id}</span>} width="xl" footer={<Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>}>
    <div className="grid gap-5">
      <dl className="grid overflow-hidden rounded-lg border sm:grid-cols-2"><Fact label={t("logs.time")} value={new Date(interaction.created_at).toLocaleString(i18n.language)} /><Fact label={t("logs.outcome")} value={interaction.outcome} /><Fact label={t("logs.guardrail")} value={`${guardrailName(interaction.guardrail_id)} · ${interaction.guardrail_version ?? "—"}`} /><Fact label={t("logs.context")} value={`${routerName(interaction.router_id)} · ${interaction.protocol}`} /></dl>
      {!admin && interaction.entries.some((entry) => entry.content_available) ? <div className="flex gap-3 rounded-lg border bg-muted/25 p-4"><LockKeyhole className="mt-0.5 size-4 shrink-0" /><div><p className="text-sm font-medium">{t("logs.adminContentTitle")}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("logs.adminContentDescription")}</p></div></div> : null}
      {checkpoints.isPending ? <p role="status">{t('common.loading')}</p> : checkpoints.error ? <ErrorNotice error={checkpoints.error} /> : null}
      <div className="grid gap-2">{checkpoints.data?.items.map(event => <Button key={event.id} variant={expanded === event.id ? 'secondary' : 'outline'} className="h-auto justify-start whitespace-normal break-all text-left" onClick={() => setExpanded(expanded === event.id ? null : event.id)} aria-expanded={expanded === event.id}>{new Date(event.occurredAt).toLocaleString(i18n.language)} · {event.direction} · {event.id}</Button>)}</div>
      <EventPagination page={paging.page} busy={checkpoints.isFetching} nextCursor={checkpoints.data?.nextCursor} onNext={cursor => { setExpanded(null); paging.next(cursor); }} onPrevious={() => { setExpanded(null); paging.previous(); }} onLatest={() => { setExpanded(null); paging.latest(); }} />
      {expanded && detail.isPending ? <p role="status">{t('common.loading')}</p> : expanded && detail.error ? <ErrorNotice error={detail.error} /> : detail.data ? <RuntimeCheckpoint key={detail.data.id} entry={detail.data} admin={admin} /> : null}
    </div>
  </EntitySheet>;
}

export function RuntimeCheckpoint({ entry, admin }: { entry: RuntimeLogEntry; admin: boolean }) {
  const { t } = useTranslation();
  const Icon = entry.phase === "input" ? ArrowDownToLine : ArrowUpFromLine;
  return <section className="overflow-hidden rounded-lg border"><header className="flex flex-wrap items-center gap-3 border-b bg-muted/25 px-4 py-3"><span className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary"><Icon className="size-4" /></span><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{t(entry.phase === "input" ? "logs.inboundCheckpoint" : "logs.outboundCheckpoint")}</h3><p className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground">{entry.trace_id}</p></div><StateBadge state={entry.outcome} /><span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground"><Clock3 className="size-3" />{entry.latency_ms} ms</span></header>
    <div className="grid gap-4 p-4">
      {admin ? <ContentPanel title={t(entry.phase === "output" ? "logs.modelOutput" : "logs.requestContent")} description={t(entry.phase === "output" ? "logs.modelOutputDescription" : "logs.requestContentDescription")} blocks={entry.content_before} available={entry.content_available} /> : null}
      {admin && entry.outcome === "transform" ? <ContentPanel title={t("logs.transformedContent")} description={t("logs.transformedDescription")} blocks={entry.content_after} available={entry.content_available} transformed /> : null}
      <p className="text-xs leading-5 text-muted-foreground">{entry.detail}</p>
      {entry.findings.length ? <div><h4 className="text-xs font-semibold">{t("logs.findings")}</h4><div className="mt-2 grid gap-2">{entry.findings.map((finding) => <div key={finding.id} className="rounded-md border p-3 text-xs"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{finding.severity}</Badge><strong>{finding.policy_id ?? finding.risk}</strong>{finding.rule_id ? <code className="text-[10px] text-muted-foreground">{finding.rule_id}</code> : null}</div><p className="mt-2 leading-5 text-muted-foreground">{finding.detail}</p></div>)}</div></div> : null}
      <ExecutionTrace steps={entry.steps} />
    </div>
  </section>;
}

function ContentPanel({ title, description, blocks, available, transformed = false }: { title: string; description: string; blocks: RuntimeLogContentBlock[] | null; available: boolean; transformed?: boolean }) {
  const { t } = useTranslation();
  return <section className="min-w-0 rounded-md border bg-card">
    <header className="border-b px-4 py-3"><h4 className="text-sm font-semibold">{title}</h4><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></header>
    {blocks?.length ? <div className="divide-y">{blocks.map((block) => <div key={block.id} className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-muted/30 px-4 py-2 text-xs text-muted-foreground"><span>{t("logs.contentRole")}: <span className="font-medium text-foreground">{block.role}</span></span>{block.source !== block.role ? <span className="break-all">{t("logs.contentSource")}: {block.source}</span> : null}{block.truncated ? <span>{t("logs.truncated")}</span> : null}</div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-4 py-4 font-sans text-sm leading-7 text-foreground">{block.text}</pre>
    </div>)}</div> : <div className="px-4 py-5 text-sm text-muted-foreground">{t(available ? "logs.contentUnavailable" : "logs.contentNotCaptured")}</div>}
    {transformed ? <p className="border-t px-4 py-2 text-xs text-muted-foreground">{t("logs.transformation")}</p> : null}
  </section>;
}

export type TraceNode = { step: RouterTraceStep; children: TraceNode[] };

// Only recorded parent links establish hierarchy. Break cycles and keep orphaned spans visible.
export function buildTraceForest(steps: RouterTraceStep[]): TraceNode[] {
  const nodes = steps.map((step) => ({ step, children: [] as TraceNode[] }));
  const byId = new Map(nodes.map((node) => [node.step.id, node]));
  const roots: TraceNode[] = [];
  for (const node of nodes) {
    const parent = node.step.parent_id ? byId.get(node.step.parent_id) : undefined;
    const visited = new Set([node.step.id]);
    let ancestor = parent;
    while (ancestor && !visited.has(ancestor.step.id)) {
      visited.add(ancestor.step.id);
      ancestor = ancestor.step.parent_id ? byId.get(ancestor.step.parent_id) : undefined;
    }
    if (parent && !ancestor) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function ExecutionTrace({ steps }: { steps: RouterTraceStep[] }) {
  const { t } = useTranslation();
  const roots = useMemo(() => buildTraceForest(steps), [steps]);
  const hasHierarchy = roots.some((node) => node.children.length > 0);
  return <section className="min-w-0 border-t pt-4">
    <div className="flex items-center justify-between gap-3"><h4 className="text-sm font-semibold">{t("logs.executionTrace")}</h4><span className="text-xs text-muted-foreground">{t("logs.traceSpans", { count: steps.length })}</span></div>
    <p className="mt-1 text-xs leading-5 text-muted-foreground">{t(!steps.length ? "logs.traceEmpty" : hasHierarchy ? "logs.traceTreeDescription" : "logs.traceFlatDescription")}</p>
    <ol className="mt-3">{roots.map((node, index) => <TraceBranch key={`${node.step.id}:${index}`} node={node} />)}</ol>
  </section>;
}

function TraceBranch({ node }: { node: TraceNode }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const { step, children } = node;
  return <li className="relative min-w-0">
    <div className="flex min-h-11 items-start gap-1 rounded-md py-1 hover:bg-muted/30">
      {children.length ? <Button variant="ghost" size="icon" className="size-11 shrink-0" aria-expanded={expanded} aria-label={t(expanded ? "logs.collapseSpan" : "logs.expandSpan", { name: step.name })} onClick={() => setExpanded(!expanded)}><ChevronRight className={`size-4 ${expanded ? "rotate-90" : ""}`} /></Button> : <span className="grid size-11 shrink-0 place-items-center text-muted-foreground">{step.kind === "rail" ? <Workflow className="size-4" /> : <FileCode2 className="size-4" />}</span>}
      <button type="button" aria-label={t("logs.inspectSpan", { name: step.name })} aria-expanded={showDetails} className="min-h-11 min-w-0 flex-1 rounded-sm py-2 text-left focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setShowDetails(!showDetails)}>
        <span className="block break-all text-xs font-medium leading-5">{step.name}</span><span className="block text-[11px] text-muted-foreground">{step.kind}{step.parallel_group ? ` · ${t("logs.parallelGroup")}: ${step.parallel_group}` : ""}</span>
      </button>
      <div className="flex shrink-0 flex-col items-end gap-1 px-2 py-2"><StateBadge state={step.outcome} /><span className="font-mono text-[11px] tabular-nums text-muted-foreground">{step.latency_ms} ms</span></div>
    </div>
    {showDetails ? <dl className="mb-3 ml-3 grid gap-2 border-l-2 px-3 py-2 text-xs"><RuntimeFact label={t("logs.spanId")} value={step.id} /><div><dt className="text-muted-foreground">{t("logs.checkpointDetail")}</dt><dd className="mt-1 break-words leading-5">{step.detail || t("logs.noSpanDetail")}</dd></div>{step.parent_id ? <div><dt className="text-muted-foreground">{t("logs.parentSpan")}</dt><dd className="mt-1 break-all font-mono">{step.parent_id}</dd></div> : null}</dl> : null}
    {children.length && expanded ? <ol className="ml-3 border-l border-border pl-2 sm:ml-5 sm:pl-3 [&>li]:before:absolute [&>li]:before:top-6 [&>li]:before:-left-2 [&>li]:before:w-2 [&>li]:before:border-t [&>li]:before:border-border sm:[&>li]:before:-left-3 sm:[&>li]:before:w-3">{children.map((child, index) => <TraceBranch key={`${child.step.id}:${index}`} node={child} />)}</ol> : null}
  </li>;
}

function Fact({ label, value }: { label: string; value: string }) { return <div className="border-b p-4 last:border-b-0 sm:border-r sm:[&:nth-child(even)]:border-r-0 sm:[&:nth-last-child(-n+2)]:border-b-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-all text-sm font-medium">{value}</dd></div>; }
