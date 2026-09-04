import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Clock3,
  FileCode2,
  Filter,
  LockKeyhole,
  ScrollText,
  Workflow,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { EntitySheet } from "@/components/entity-sheet";
import { EmptyState, ErrorNotice, PageHeader, StateBadge } from "@/components/product-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { queryKeys } from "@/features/query-keys";
import { useAuth } from "@/lib/auth";
import {
  getDeployments,
  getGuardrailLoggingSettings,
  getGuardrails,
  getRuntimeLogs,
  type MetricWindow,
  type RuntimeLogContentBlock,
  type RuntimeLogEntry,
  type RuntimeLogInteraction,
} from "@/lib/api";

type PhaseFilter = "all" | "input" | "output";
type OutcomeFilter = "all" | "allow" | "transform" | "block" | "error";

export function LogsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState("prompt");
  const [guardrailId, setGuardrailId] = useState("all");
  const [window, setWindow] = useState<MetricWindow>("24h");
  const [phase, setPhase] = useState<PhaseFilter>("all");
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [selected, setSelected] = useState<RuntimeLogInteraction | null>(null);
  const auth = useAuth();
  const guardrailsQuery = useQuery({ queryKey: queryKeys.guardrails, queryFn: getGuardrails });
  const deploymentsQuery = useQuery({ queryKey: queryKeys.deployments, queryFn: getDeployments });
  const scopedGuardrailId = guardrailId === "all" ? undefined : guardrailId;
  const filterKey = { guardrailId: scopedGuardrailId, phase: phase === "all" ? undefined : phase, outcome: outcome === "all" ? undefined : outcome, window };
  const logsQuery = useInfiniteQuery({
    queryKey: queryKeys.runtimeLogs(filterKey),
    queryFn: ({ pageParam }) => getRuntimeLogs({
      limit: 50,
      guardrailId: scopedGuardrailId,
      phase: phase === "all" ? undefined : phase,
      outcome: outcome === "all" ? undefined : outcome,
      window,
      cursor: pageParam,
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    refetchInterval: 15_000,
  });
  const settingsQuery = useQuery({
    queryKey: queryKeys.guardrailLogging(scopedGuardrailId ?? ""),
    queryFn: () => getGuardrailLoggingSettings(scopedGuardrailId!),
    enabled: Boolean(scopedGuardrailId),
  });
  const interactions = useMemo(() => logsQuery.data?.pages.flatMap((page) => page.items) ?? [], [logsQuery.data]);
  const guardrails = guardrailsQuery.data?.items ?? [];
  const deployments = deploymentsQuery.data?.items ?? [];
  const guardrailName = (id: string | null) => guardrails.find((item) => item.id === id)?.name ?? id ?? "—";
  const deploymentName = (id: string | null) => deployments.find((item) => item.id === id)?.name ?? id ?? t("logs.directRuntime");

  return (
    <section className="py-6 sm:py-8">
      <PageHeader title={t("pages.logs.title")} description={t("logs.description")} />

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

      <Tabs value={tab} onValueChange={setTab} className="mt-5">
        <TabsList aria-label={t("logs.views")}>
          <TabsTrigger value="prompt">{t("logs.promptHistory")}</TabsTrigger>
          <TabsTrigger value="audit">{t("logs.auditLog")}</TabsTrigger>
        </TabsList>
        <TabsContent value="prompt" className="pt-4">
          <PromptHistory
            interactions={interactions}
            loading={logsQuery.isLoading}
            error={logsQuery.error}
            hasMore={logsQuery.hasNextPage}
            loadingMore={logsQuery.isFetchingNextPage}
            onLoadMore={() => void logsQuery.fetchNextPage()}
            onInspect={setSelected}
            guardrailName={guardrailName}
            deploymentName={deploymentName}
          />
        </TabsContent>
        <TabsContent value="audit" className="pt-4">
          <AuditHistory
            interactions={interactions}
            phase={phase}
            outcome={outcome}
            loading={logsQuery.isLoading}
            error={logsQuery.error}
            hasMore={logsQuery.hasNextPage}
            loadingMore={logsQuery.isFetchingNextPage}
            onLoadMore={() => void logsQuery.fetchNextPage()}
            onInspect={setSelected}
            guardrailName={guardrailName}
            deploymentName={deploymentName}
          />
        </TabsContent>
      </Tabs>

      <RuntimeLogSheet
        interaction={selected}
        admin={auth.user?.role === "admin"}
        guardrailName={guardrailName}
        deploymentName={deploymentName}
        open={Boolean(selected)}
        onOpenChange={(open) => { if (!open) setSelected(null); }}
      />
    </section>
  );
}

function LogFilter({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1.5"><span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Filter className="size-3" />{label}</span>{children}</label>;
}

function PromptHistory({ interactions, loading, error, hasMore, loadingMore, onLoadMore, onInspect, guardrailName, deploymentName }: { interactions: RuntimeLogInteraction[]; loading: boolean; error: unknown; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void; onInspect: (item: RuntimeLogInteraction) => void; guardrailName: (id: string | null) => string; deploymentName: (id: string | null) => string }) {
  const { t, i18n } = useTranslation();
  if (loading) return <Skeleton className="h-[30rem] rounded-xl" />;
  if (error) return <ErrorNotice error={error} />;
  if (!interactions.length) return <EmptyState title={t("logs.emptyPromptTitle")} description={t("logs.emptyPromptDescription")} />;
  return <Card className="gap-0 overflow-hidden p-0 shadow-none">
    <div className="overflow-x-auto"><table className="w-full min-w-[58rem] table-fixed text-left text-xs"><thead className="border-b bg-muted/40 text-muted-foreground"><tr><th className="h-10 w-44 px-4 font-medium">{t("logs.time")}</th><th className="h-10 w-52 px-4 font-medium">{t("logs.guardrail")}</th><th className="h-10 w-28 px-4 font-medium">{t("logs.direction")}</th><th className="h-10 w-28 px-4 font-medium">{t("logs.outcome")}</th><th className="h-10 px-4 font-medium">{t("logs.context")}</th><th className="h-10 w-24 px-4 text-right font-medium">{t("logs.latency")}</th><th className="h-10 w-14"><span className="sr-only">{t("logs.inspect")}</span></th></tr></thead>
    <tbody className="divide-y">{interactions.map((item) => { const phases = new Set(item.entries.map((entry) => entry.phase)); const latency = item.entries.reduce((sum, entry) => sum + entry.latency_ms, 0); return <tr key={item.id} className="h-14 hover:bg-muted/30"><td className="px-4 font-mono text-[11px] tabular-nums text-muted-foreground">{new Date(item.created_at).toLocaleString(i18n.language)}</td><td className="px-4"><strong className="block truncate text-xs font-medium">{guardrailName(item.guardrail_id)}</strong><span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{t("logs.version", { version: item.guardrail_version ?? "—" })}</span></td><td className="px-4"><Direction phases={phases} /></td><td className="px-4"><StateBadge state={item.outcome} /></td><td className="truncate px-4"><span className="block truncate">{deploymentName(item.deployment_id)}</span><span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{item.protocol} · {item.id}</span></td><td className="px-4 text-right font-mono text-[11px] tabular-nums">{latency} ms</td><td><Button size="icon" variant="ghost" className="size-11" aria-label={t("logs.inspectRecord", { id: item.id })} onClick={() => onInspect(item)}><ScrollText className="size-4" /></Button></td></tr>; })}</tbody></table></div>
    {hasMore ? <div className="flex justify-center border-t p-3"><Button variant="outline" className="min-h-11" disabled={loadingMore} onClick={onLoadMore}>{t(loadingMore ? "logs.loadingMore" : "logs.loadMore")}</Button></div> : null}
  </Card>;
}

function Direction({ phases }: { phases: Set<string> }) {
  const { t } = useTranslation();
  if (phases.has("input") && phases.has("output")) return <span className="inline-flex items-center gap-1 text-[11px]"><ArrowDownToLine className="size-3 text-primary" /><span aria-hidden>→</span><ArrowUpFromLine className="size-3 text-primary" /><span className="sr-only">{t("logs.bothDirections")}</span></span>;
  if (phases.has("output")) return <span className="inline-flex items-center gap-1.5"><ArrowUpFromLine className="size-3.5 text-primary" />{t("logs.outbound")}</span>;
  return <span className="inline-flex items-center gap-1.5"><ArrowDownToLine className="size-3.5 text-primary" />{t("logs.inbound")}</span>;
}

export function AuditHistory({ interactions, phase, outcome, loading, error, hasMore, loadingMore, onLoadMore, onInspect, guardrailName, deploymentName }: { interactions: RuntimeLogInteraction[]; phase: PhaseFilter; outcome: OutcomeFilter; loading: boolean; error: unknown; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void; onInspect: (item: RuntimeLogInteraction) => void; guardrailName: (id: string | null) => string; deploymentName: (id: string | null) => string }) {
  const { t, i18n } = useTranslation();
  const records = useMemo(() => interactions.flatMap((interaction) => interaction.entries
    .filter((entry) => phase === "all" || entry.phase === phase)
    .filter((entry) => outcome === "all" || entry.outcome === outcome)
    .map((entry) => ({ interaction, entry })))
    .sort((left, right) => Date.parse(right.entry.created_at) - Date.parse(left.entry.created_at)), [interactions, outcome, phase]);
  if (loading) return <Skeleton className="h-[28rem] rounded-xl" />;
  if (error) return <ErrorNotice error={error} />;
  if (!records.length) return <EmptyState title={t("logs.emptyAuditTitle")} description={t("logs.emptyAuditDescription")} />;
  return <Card className="gap-0 overflow-hidden p-0 shadow-none">
    <div className="border-b px-4 py-3"><p className="text-xs font-semibold">{t("logs.trafficAuditTitle")}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("logs.trafficAuditDescription")}</p></div>
    <div className="overflow-x-auto"><table className="w-full min-w-[64rem] table-fixed text-left text-xs"><thead className="border-b bg-muted/40 text-muted-foreground"><tr><th className="h-10 w-44 px-4 font-medium">{t("logs.time")}</th><th className="h-10 w-28 px-4 font-medium">{t("logs.direction")}</th><th className="h-10 w-48 px-4 font-medium">{t("logs.guardrail")}</th><th className="h-10 w-28 px-4 font-medium">{t("logs.outcome")}</th><th className="h-10 px-4 font-medium">{t("logs.auditDetail")}</th><th className="h-10 w-24 px-4 text-right font-medium">{t("logs.latency")}</th><th className="h-10 w-14"><span className="sr-only">{t("logs.inspect")}</span></th></tr></thead><tbody className="divide-y">{records.map(({ interaction, entry }) => <tr key={entry.id} className="min-h-14 hover:bg-muted/30"><td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">{new Date(entry.created_at).toLocaleString(i18n.language)}</td><td className="px-4 py-3"><Direction phases={new Set([entry.phase])} /></td><td className="px-4 py-3"><strong className="block truncate text-xs font-medium">{guardrailName(interaction.guardrail_id)}</strong><span className="mt-0.5 block text-[11px] text-muted-foreground">{t("logs.version", { version: interaction.guardrail_version ?? "—" })}</span></td><td className="px-4 py-3"><StateBadge state={entry.outcome} /></td><td className="px-4 py-3"><p className="leading-5">{entry.detail}</p><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{deploymentName(interaction.deployment_id)} · {interaction.protocol} · {entry.trace_id}</p></td><td className="px-4 py-3 text-right font-mono text-[11px] tabular-nums">{entry.latency_ms} ms</td><td><Button size="icon" variant="ghost" className="size-11" aria-label={t("logs.inspectAuditRecord", { id: entry.id })} onClick={() => onInspect(interaction)}><ScrollText className="size-4" /></Button></td></tr>)}</tbody></table></div>
    {hasMore ? <div className="flex justify-center border-t p-3"><Button variant="outline" className="min-h-11" disabled={loadingMore} onClick={onLoadMore}>{t(loadingMore ? "logs.loadingMore" : "logs.loadMore")}</Button></div> : null}
  </Card>;
}

function RuntimeLogSheet({ interaction, admin, guardrailName, deploymentName, open, onOpenChange }: { interaction: RuntimeLogInteraction | null; admin: boolean; guardrailName: (id: string | null) => string; deploymentName: (id: string | null) => string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, i18n } = useTranslation();
  if (!interaction) return null;
  return <EntitySheet open={open} onOpenChange={onOpenChange} eyebrow={t("logs.detailEyebrow")} title={t("logs.detailTitle")} description={interaction.id} width="xl" footer={<Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>}>
    <div className="grid gap-5">
      <dl className="grid overflow-hidden rounded-lg border sm:grid-cols-2"><Fact label={t("logs.time")} value={new Date(interaction.created_at).toLocaleString(i18n.language)} /><Fact label={t("logs.outcome")} value={interaction.outcome} /><Fact label={t("logs.guardrail")} value={`${guardrailName(interaction.guardrail_id)} · ${interaction.guardrail_version ?? "—"}`} /><Fact label={t("logs.context")} value={`${deploymentName(interaction.deployment_id)} · ${interaction.protocol}`} /></dl>
      {!admin && interaction.entries.some((entry) => entry.content_available) ? <div className="flex gap-3 rounded-lg border bg-muted/25 p-4"><LockKeyhole className="mt-0.5 size-4 shrink-0" /><div><p className="text-sm font-medium">{t("logs.adminContentTitle")}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("logs.adminContentDescription")}</p></div></div> : null}
      <div className="grid gap-4">{interaction.entries.map((entry) => <RuntimeCheckpoint key={entry.id} entry={entry} admin={admin} />)}</div>
    </div>
  </EntitySheet>;
}

function RuntimeCheckpoint({ entry, admin }: { entry: RuntimeLogEntry; admin: boolean }) {
  const { t } = useTranslation();
  const Icon = entry.phase === "input" ? ArrowDownToLine : ArrowUpFromLine;
  return <section className="overflow-hidden rounded-lg border"><header className="flex flex-wrap items-center gap-3 border-b bg-muted/25 px-4 py-3"><span className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary"><Icon className="size-4" /></span><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{t(entry.phase === "input" ? "logs.inboundCheckpoint" : "logs.outboundCheckpoint")}</h3><p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{entry.trace_id}</p></div><StateBadge state={entry.outcome} /><span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground"><Clock3 className="size-3" />{entry.latency_ms} ms</span></header>
    <div className="grid gap-4 p-4">
      {admin ? <ContentPanel title={t("logs.originalContent")} blocks={entry.content_before} available={entry.content_available} /> : null}
      {admin && entry.outcome === "transform" ? <ContentPanel title={t("logs.transformedContent")} blocks={entry.content_after} available={entry.content_available} transformed /> : null}
      <p className="text-xs leading-5 text-muted-foreground">{entry.detail}</p>
      {entry.findings.length ? <div><h4 className="text-xs font-semibold">{t("logs.findings")}</h4><div className="mt-2 grid gap-2">{entry.findings.map((finding) => <div key={finding.id} className="rounded-md border p-3 text-xs"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{finding.severity}</Badge><strong>{finding.policy_id ?? finding.risk}</strong>{finding.rule_id ? <code className="text-[10px] text-muted-foreground">{finding.rule_id}</code> : null}</div><p className="mt-2 leading-5 text-muted-foreground">{finding.detail}</p></div>)}</div></div> : null}
      {entry.steps.length ? <div><h4 className="text-xs font-semibold">{t("logs.executionTrace")}</h4><ol className="mt-2 divide-y rounded-md border">{entry.steps.map((step) => <li key={step.id} className="flex min-h-11 items-center gap-3 px-3 py-2 text-xs"><span className="text-primary">{step.kind === "rail" ? <Workflow className="size-3.5" /> : <FileCode2 className="size-3.5" />}</span><span className="min-w-0 flex-1 truncate">{step.name}</span><StateBadge state={step.outcome} /><span className="font-mono text-[10px] text-muted-foreground">{step.latency_ms} ms</span></li>)}</ol></div> : null}
    </div>
  </section>;
}

function ContentPanel({ title, blocks, available, transformed = false }: { title: string; blocks: RuntimeLogContentBlock[] | null; available: boolean; transformed?: boolean }) {
  const { t } = useTranslation();
  return <div><div className="mb-2 flex items-center justify-between gap-2"><h4 className="text-xs font-semibold">{title}</h4>{transformed ? <Badge variant="outline">{t("logs.transformation")}</Badge> : null}</div>{blocks?.length ? <div className="grid gap-2">{blocks.map((block) => <div key={block.id} className="overflow-hidden rounded-md border bg-muted/15"><div className="flex items-center justify-between gap-3 border-b px-3 py-2 text-[10px] text-muted-foreground"><span>{block.role} · {block.source}</span>{block.truncated ? <span>{t("logs.truncated")}</span> : null}</div><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words p-3 font-sans text-xs leading-5">{block.text}</pre></div>)}</div> : <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">{t(available ? "logs.contentUnavailable" : "logs.contentNotCaptured")}</div>}</div>;
}

function Fact({ label, value }: { label: string; value: string }) { return <div className="border-b p-4 last:border-b-0 sm:border-r sm:[&:nth-child(even)]:border-r-0 sm:[&:nth-last-child(-n+2)]:border-b-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-all text-sm font-medium">{value}</dd></div>; }
