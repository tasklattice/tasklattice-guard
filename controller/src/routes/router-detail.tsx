import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Building2,
  Clock3,
  FileCode2,
  Filter,
  ListFilter,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Route,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Workflow,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { EntitySheet } from "@/components/entity-sheet";
import { EventPagination, useEventCursor } from '@/components/event-pagination';
import { getRouterTrace } from '@/lib/routers-api';
import { CopyableChecksum } from "@/components/copyable-checksum";
import { formatEventTimestamp } from "@/components/dashboard/event-time";
import { ProtectedDeleteSheet } from "@/components/protected-delete-sheet";
import { EmptyState, ErrorNotice, InfoNotice, StateBadge } from "@/components/product-shell";
import {
  createTrafficScopeQuery,
  fromTrafficScopeExpression,
  isTrafficScopeValid,
  toTrafficScopeExpression,
  TrafficScopeBuilder,
  type TrafficScopeQuery,
} from "@/components/traffic-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { queryKeys } from "@/features/query-keys";
import { useAuth } from "@/lib/auth";
import {
  getRouter,
  deleteRouter,
  getRouterDeletionImpact,
  getRouterTraces,
  getGuardrailVersion,
  getGuardrails,
  getEndpoints,
  getMetrics,
  getPolicies,
  getTrafficScopeFields,
  updateRouterTrafficScope,
  type Router,
  type RouterDeletionImpact,
  type RouterRuntimeTrace,
  type RouterTraceFinding,
  type GuardrailVersionDetail,
  type Endpoint,
  type Metrics,
  type Policy,
  type TrafficScopeField,
} from "@/lib/api";
import { filterDefinitionsForProtocol, TrafficScopeBadges } from "@/routes/routers";

const EMPTY_FIELDS: TrafficScopeField[] = [];

type RouterDeletionConfirmation = {
  reason: string;
  confirm_recent_traffic: boolean;
  confirmation_name?: string;
};

export function RouterDetailPage() {
  const { t } = useTranslation();
  const { routerId } = useParams({ strict: false }) as { routerId: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const auth = useAuth();
  const canManage = auth.user?.role === "admin";
  const [section, setSection] = useState("runtime");
  const [severity, setSeverity] = useState<FindingSeverityFilter>('all');
  const paging = useEventCursor(JSON.stringify([routerId, section, severity]));
  const [editScopeOpen, setEditScopeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedTrace, setSelectedTrace] = useState<RouterRuntimeTrace | null>(null);
  const routerQuery = useQuery({ queryKey: queryKeys.router(routerId), queryFn: () => getRouter(routerId) });
  const guardrailsQuery = useQuery({ queryKey: queryKeys.guardrails, queryFn: getGuardrails });
  const endpointsQuery = useQuery({ queryKey: queryKeys.endpoints, queryFn: getEndpoints });
  const policiesQuery = useQuery({ queryKey: queryKeys.policies, queryFn: getPolicies });
  const fieldsQuery = useQuery({ queryKey: queryKeys.trafficScopeFields, queryFn: getTrafficScopeFields });
  const tracesQuery = useQuery({
    queryKey: [...queryKeys.routerTraces(routerId, 100), section, severity, paging.cursor ?? null],
    queryFn: ({ signal }) => getRouterTraces(routerId, 100, paging.cursor, signal, section === 'security' ? { severity } : undefined),
    refetchInterval: paging.page === 1 && (section === 'runtime' || section === 'security') ? 15_000 : false,
    refetchOnWindowFocus: false,
    gcTime: 30_000,
  });
  const traceDetail = useQuery({ queryKey: ['event-detail', selectedTrace?.id], enabled: Boolean(selectedTrace), queryFn: ({ signal }) => getRouterTrace(selectedTrace!.id, signal), gcTime: 0 });
  const metricsQuery = useQuery({
    queryKey: queryKeys.metricsScope({ routerId, window: "24h" }),
    queryFn: ({ signal }) => getMetrics({ routerId, window: "24h" }, signal),
  });
  const deletionImpactQuery = useQuery({
    queryKey: queryKeys.routerDeletionImpact(routerId),
    queryFn: () => getRouterDeletionImpact(routerId),
    enabled: deleteOpen,
    staleTime: 0,
  });
  const deleteMutation = useMutation({
    mutationFn: (confirmation: RouterDeletionConfirmation) => deleteRouter(routerId, confirmation),
    onSuccess: async () => {
      toast.success(t("routerDetail.deleteSucceeded"));
      await queryClient.cancelQueries({ queryKey: queryKeys.router(routerId) });
      queryClient.removeQueries({ queryKey: queryKeys.router(routerId) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routers, exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.metrics }),
        queryClient.invalidateQueries({ queryKey: queryKeys.auditEvents }),
        queryClient.invalidateQueries({ queryKey: queryKeys.systemStatus }),
      ]);
      navigate({ to: "/integration/routers" });
    },
    onError: async () => { await deletionImpactQuery.refetch(); },
  });
  const router = routerQuery.data;
  const guardrail = guardrailsQuery.data?.items.find((item) => item.id === router?.guardrail_id);
  const endpoint = endpointsQuery.data?.items.find((item) => item.id === router?.endpoint_id);
  const versionQuery = useQuery({
    queryKey: queryKeys.guardrailVersion(router?.guardrail_id ?? "", router?.guardrail_version ?? ""),
    queryFn: () => getGuardrailVersion(router!.guardrail_id, router!.guardrail_version),
    enabled: Boolean(router?.guardrail_id && router.guardrail_version),
  });

  async function refreshRouter() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.router(routerId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.routers }),
      queryClient.invalidateQueries({ queryKey: queryKeys.metrics }),
      queryClient.invalidateQueries({ queryKey: queryKeys.routerTraces(routerId, 100) }),
    ]);
  }

  if (routerQuery.isLoading) return <Skeleton className="mt-8 h-[38rem] rounded-xl" />;
  if (routerQuery.error || !router) return <div className="py-8"><ErrorNotice error={routerQuery.error ?? new Error(t("routerDetail.notFound"))} /></div>;
  const traces = tracesQuery.data?.items ?? [];
  const policies = policiesQuery.data?.items ?? [];
  const findingCount = metricsQuery.data?.findings_summary?.total ?? traces.reduce((count, trace) => count + trace.findings.length, 0);

  return (
    <section className="py-6 sm:py-8">
      <Link to="/integration/routers" className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />{t("routerDetail.back")}</Link>
      <div className="mt-3 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-2xl font-semibold tracking-[-0.015em] sm:text-3xl">{router.name}</h1>
            <StateBadge state={router.enabled ? "protected" : "paused"} />
            <Badge variant="outline">{t("routers.version", { version: router.guardrail_version })}</Badge>
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{t("routerDetail.description", { endpoint: endpoint?.name ?? t("routerDetail.directRuntime"), guardrail: guardrail?.name ?? router.guardrail_id })}</p>
        </div>
        {canManage && !router.system_managed ? <div className="flex flex-wrap gap-2">
          <Button className="min-h-11" variant="outline" onClick={() => { setSection("traffic"); setEditScopeOpen(true); }}><Pencil />{t("routerDetail.editSelector")}</Button>
          <Button className="min-h-11 text-destructive hover:bg-destructive/10 hover:text-destructive" variant="outline" onClick={() => {
            deleteMutation.reset();
            queryClient.removeQueries({ queryKey: queryKeys.routerDeletionImpact(routerId), exact: true });
            setDeleteOpen(true);
          }}><Trash2 />{t("routerDetail.deleteAction")}</Button>
        </div> : null}
      </div>

      <Tabs value={section} onValueChange={setSection} className="mt-7">
        <div className="overflow-x-auto">
          <TabsList className="min-w-max" aria-label={t("routerDetail.detailViews")}>
            <TabsTrigger value="runtime"><Activity />{t("routerDetail.runtimeTab")}</TabsTrigger>
            <TabsTrigger value="security"><ShieldAlert />{t("routerDetail.securityTab")}<Badge variant="outline" className="ml-1 min-w-5 justify-center px-1.5 font-mono text-[10px]">{findingCount}</Badge></TabsTrigger>
            <TabsTrigger value="binding"><LockKeyhole />{t("routerDetail.bindingTab")}</TabsTrigger>
            <TabsTrigger value="traffic"><ListFilter />{t("routerDetail.trafficTab")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="runtime" className="pt-5">
          <RouterRuntimeView
            metrics={metricsQuery.data}
            metricsLoading={metricsQuery.isLoading}
            metricsError={metricsQuery.error}
            traces={traces}
            tracesLoading={tracesQuery.isLoading}
            tracesError={tracesQuery.error}
            policies={policies}
            onInspect={setSelectedTrace}
            onOpenSecurity={() => setSection("security")}
          />
        </TabsContent>
        <TabsContent value="security" className="pt-5">
          <RouterSecurityView
            severity={severity}
            onSeverityChange={setSeverity}
            summary={metricsQuery.data?.findings_summary}
            traces={traces}
            loading={tracesQuery.isLoading}
            error={tracesQuery.error}
            policies={policies}
            onInspect={setSelectedTrace}
          />
        </TabsContent>
        <TabsContent value="binding" className="pt-5">
          <RouterBindingView router={router} endpoint={endpoint} guardrailName={guardrail?.name} version={versionQuery.data} loading={versionQuery.isLoading || guardrailsQuery.isLoading || endpointsQuery.isLoading} />
        </TabsContent>
        <TabsContent value="traffic" className="pt-5">
          <RouterTrafficView router={router} endpoint={endpoint} canManage={canManage} onEdit={() => setEditScopeOpen(true)} />
        </TabsContent>
      </Tabs>
      {(section === 'runtime' || section === 'security') && <EventPagination page={paging.page} busy={tracesQuery.isFetching} nextCursor={tracesQuery.data?.nextCursor} onNext={paging.next} onPrevious={paging.previous} onLatest={paging.latest} />}
      {selectedTrace && traceDetail.isPending ? <p role="status">{t('common.loading')}</p> : null}
      {selectedTrace && traceDetail.error ? <ErrorNotice error={traceDetail.error} /> : null}

      <EditTrafficScopeSheet
        router={router}
        endpoint={endpoint}
        definitions={fieldsQuery.data?.items ?? EMPTY_FIELDS}
        loading={fieldsQuery.isLoading}
        error={fieldsQuery.error}
        open={editScopeOpen}
        onOpenChange={setEditScopeOpen}
        onSaved={async () => { setEditScopeOpen(false); await refreshRouter(); }}
      />
      <TraceDetailSheet trace={traceDetail.data ?? null} router={router} endpoint={endpoint} guardrailName={guardrail?.name} policies={policies} open={Boolean(selectedTrace && traceDetail.data)} onOpenChange={(open) => { if (!open) setSelectedTrace(null); }} />
      <DeleteRouterSheet
        router={router}
        open={deleteOpen}
        impact={deletionImpactQuery.data}
        loading={deletionImpactQuery.isFetching}
        deleting={deleteMutation.isPending}
        error={deleteMutation.error instanceof Error ? deleteMutation.error : deletionImpactQuery.error instanceof Error ? deletionImpactQuery.error : null}
        onOpenChange={(open) => { if (!deleteMutation.isPending) { setDeleteOpen(open); if (!open) deleteMutation.reset(); } }}
        onRetry={() => { deleteMutation.reset(); void deletionImpactQuery.refetch(); }}
        onConfirm={(confirmation) => deleteMutation.mutate(confirmation)}
      />
    </section>
  );
}

export function DeleteRouterSheet({ router, open, impact, loading, deleting, error, onOpenChange, onRetry, onConfirm }: {
  router: Router;
  open: boolean;
  impact?: RouterDeletionImpact;
  loading: boolean;
  deleting: boolean;
  error: Error | null;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  onConfirm: (confirmation: RouterDeletionConfirmation) => void;
}) {
  const { t, i18n } = useTranslation();
  const [reason, setReason] = useState("");
  const telemetryFresh = Boolean(impact?.telemetry_fresh);
  const requiresSecondConfirmation = Boolean(impact?.requires_second_confirmation);

  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  return <ProtectedDeleteSheet
    open={open}
    onOpenChange={onOpenChange}
    entityName={router.name}
    loading={loading}
    ready={telemetryFresh}
    deleting={deleting}
    error={impact && !telemetryFresh ? new Error(t("routerDetail.deleteTelemetryStale")) : error}
    requiresConfirmation={requiresSecondConfirmation}
    impactItems={impact ? [
      { label: t("routerDetail.recentIncomingRequests", { minutes: impact.window_minutes }), value: impact.incoming_request_count.toLocaleString(i18n.language) },
      { label: t("routerDetail.activeRouteAffected"), value: impact.active_router_count.toLocaleString(i18n.language) },
    ] : []}
    copy={{
      eyebrow: t("routerDetail.deleteEyebrow"),
      title: t("routerDetail.deleteDialogTitle"),
      description: t("routerDetail.deleteDialogDescription", { name: router.name }),
      protectedMessage: t("routerDetail.recentTrafficWarning"),
      clearMessage: t("routerDetail.noRecentTraffic"),
      retentionNote: t("routerDetail.deleteRetentionNote"),
      continueLabel: t("routerDetail.continueDelete"),
      deleteLabel: t("routerDetail.deleteConfirm"),
      deletingLabel: t("routerDetail.deleting"),
      confirmTitle: t("routerDetail.deleteRecentTrafficTitle"),
      confirmDescription: t("routerDetail.deleteRecentTrafficDescription", { count: impact?.incoming_request_count ?? 0, minutes: impact?.window_minutes ?? 30 }),
      confirmWarning: t("routerDetail.deleteStopsTraffic"),
      typeNameLabel: t("routerDetail.typeNameToConfirm", { name: router.name }),
      protectedDeleteLabel: t("routerDetail.deleteDespiteTraffic"),
      cancelLabel: t("common.cancel"),
      backLabel: t("common.back"),
      retryLabel: t("common.retry"),
      reasonLabel: t("routerDetail.deleteReason"),
      reasonPlaceholder: t("routerDetail.deleteReasonPlaceholder"),
    }}
    reason={reason}
    onReasonChange={setReason}
    onRetry={onRetry}
    onConfirm={(confirmRecentTraffic, confirmationName) => onConfirm({
      reason: reason.trim(),
      confirm_recent_traffic: confirmRecentTraffic,
      ...(confirmationName ? { confirmation_name: confirmationName } : {}),
    })}
  />;
}

function RouterRuntimeView({ metrics, metricsLoading, metricsError, traces, tracesLoading, tracesError, policies, onInspect, onOpenSecurity }: { metrics?: Metrics; metricsLoading: boolean; metricsError: unknown; traces: RouterRuntimeTrace[]; tracesLoading: boolean; tracesError: unknown; policies: Policy[]; onInspect: (trace: RouterRuntimeTrace) => void; onOpenSecurity: () => void }) {
  const { t, i18n } = useTranslation();
  const criticalCount = metrics?.findings_summary?.critical ?? traces.reduce((count, trace) => count + trace.findings.filter((finding) => finding.severity === "critical").length, 0);
  return (
    <div className="space-y-4">
      <div><h2 className="text-base font-semibold">{t("routerDetail.runtimeTitle")}</h2><p className="mt-0.5 text-xs text-muted-foreground">{t("routerDetail.runtimeDescription")}</p></div>
      {metricsError ? <ErrorNotice error={metricsError} /> : null}
      {metricsLoading ? <Skeleton className="h-28 rounded-lg" /> : metrics ? (
        <dl className="grid overflow-hidden rounded-lg border border-border/65 bg-card sm:grid-cols-2 xl:grid-cols-4">
          <RuntimeStat label={t("routerDetail.protectedTraffic")} value={metrics.total_decisions.toLocaleString(i18n.language)} detail={t("routerDetail.last24Hours")} />
          <RuntimeStat label={t("routerDetail.interventionRate")} value={metrics.total_decisions ? `${metrics.intervention_rate}%` : "—"} detail={t("routerDetail.interventionDetail", { blocked: metrics.blocked, transformed: metrics.intervened })} />
          <RuntimeStat label={t("routerDetail.criticalFindings")} value={criticalCount.toLocaleString(i18n.language)} detail={t("routerDetail.openSecurityFindings")} danger={criticalCount > 0} onClick={onOpenSecurity} actionLabel={t("routerDetail.viewSecurityFindings")} />
          <RuntimeStat label={t("routerDetail.p95Latency")} value={metrics.total_decisions ? `${metrics.runtime_p95_ms} ms` : "—"} detail={t("routerDetail.last24Hours")} />
        </dl>
      ) : null}

      <RouterRuntimeEventTable traces={traces} loading={tracesLoading} error={tracesError} policies={policies} onInspect={onInspect} />
    </div>
  );
}

export function RouterRuntimeEventTable({ traces, loading, error, policies, onInspect }: { traces: RouterRuntimeTrace[]; loading: boolean; error: unknown; policies: Policy[]; onInspect: (trace: RouterRuntimeTrace) => void }) {
  const { t, i18n } = useTranslation();
  return <Card className="gap-0 overflow-hidden py-0 shadow-none">
    <header className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
      <div><div className="flex items-center gap-2"><h3 className="text-sm font-semibold">{t("routerDetail.eventLog")}</h3><Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px]">{traces.length}</Badge></div><p className="mt-0.5 text-xs text-muted-foreground">{t("routerDetail.eventLogDescription")}</p></div>
      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="size-1.5 rounded-full bg-emerald-500" />{t("routerDetail.liveEvents")}</span>
    </header>
    {loading ? <div className="space-y-px bg-border">{Array.from({ length: 8 }).map((_, index) => <Skeleton key={index} className="h-11 w-full rounded-none" />)}</div> : error ? <div className="p-4"><ErrorNotice error={error} /></div> : traces.length ? <div className="max-h-[30rem] overflow-auto [scrollbar-gutter:stable]"><table className="w-full min-w-[52rem] table-fixed text-left text-xs" aria-label={t("routerDetail.eventLog")}><thead className="sticky top-0 z-10 border-b bg-muted/95 text-[11px] text-muted-foreground backdrop-blur-sm"><tr><th scope="col" className="h-8 w-44 px-3 font-medium">{t("routerDetail.time")}</th><th scope="col" className="h-8 w-20 px-3 font-medium">{t("routerDetail.phase")}</th><th scope="col" className="h-8 w-24 px-3 font-medium">{t("routerDetail.decision")}</th><th scope="col" className="h-8 px-3 font-medium">{t("routerDetail.finding")}</th><th scope="col" className="h-8 w-20 px-3 text-right font-medium">{t("routerDetail.latency")}</th><th scope="col" className="h-8 w-12 px-0"><span className="sr-only">{t("routerDetail.inspect")}</span></th></tr></thead><tbody className="divide-y">{traces.map((trace) => {
      const timestamp = formatEventTimestamp(trace.created_at, i18n.language);
      return <tr key={trace.id} className="h-11 transition-colors hover:bg-muted/35"><td className="px-3 font-mono text-[11px] tabular-nums whitespace-nowrap" title={new Date(trace.created_at).toLocaleString(i18n.language)}><span className="text-muted-foreground">{timestamp.date}</span> {timestamp.time}</td><td className="px-3 font-mono text-[10px] uppercase text-muted-foreground">{trace.phase}</td><td className="px-3"><StateBadge state={trace.outcome} /></td><td className="truncate px-3">{trace.severity ? <span className="inline-flex max-w-full items-center gap-2"><SeverityBadge severity={trace.severity} /><span className="truncate text-[11px]">{findingTitle(trace.findings[0], policies)}</span></span> : <span className="text-[11px] text-muted-foreground">{t(trace.evidence_status === "not_collected" ? "routerDetail.evidenceNotCollected" : "routerDetail.noFinding")}</span>}</td><td className="px-3 text-right font-mono text-[11px] tabular-nums">{trace.latency_ms} ms</td><td className="p-0 text-center"><Button type="button" size="icon" variant="ghost" className="size-11 rounded-none" aria-label={t("routerDetail.inspectTrace", { id: trace.id })} onClick={() => onInspect(trace)}><ArrowUpRight className="size-3.5" /></Button></td></tr>;
    })}</tbody></table></div> : <div className="p-4"><EmptyState title={t("routerDetail.noEventsTitle")} description={t("routerDetail.noEventsDescription")} /></div>}
  </Card>;
}

type FindingSeverityFilter = "all" | RouterTraceFinding["severity"];

function RouterSecurityView({ traces, loading, error, policies, onInspect, severity, onSeverityChange, summary }: { traces: RouterRuntimeTrace[]; loading: boolean; error: unknown; policies: Policy[]; onInspect: (trace: RouterRuntimeTrace) => void; severity: FindingSeverityFilter; onSeverityChange: (value: FindingSeverityFilter) => void; summary: Metrics['findings_summary'] }) {
  const { t, i18n } = useTranslation();
  const setSeverity = onSeverityChange;
  const findings = useMemo(() => traces.flatMap((trace) => trace.findings.map((finding) => ({ trace, finding }))), [traces]);
  const counts = useMemo(() => ({
    all: summary?.total ?? 0,
    critical: summary?.critical ?? 0,
    high: summary?.high ?? 0,
    medium: summary?.medium ?? 0,
    low: summary?.low ?? 0,
  }), [summary]);
  const visibleFindings = severity === "all" ? findings : findings.filter((item) => item.finding.severity === severity);
  const filters: FindingSeverityFilter[] = ["all", "critical", "high", "medium", "low"];
  const evidenceUnavailable = traces.length > 0 && traces.some((trace) => trace.evidence_status === "not_collected");

  return <div className="space-y-4">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div><h2 className="text-base font-semibold">{t("routerDetail.securityTitle")}</h2><p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("routerDetail.securityDescription")}</p><p className="mt-2 text-xs text-muted-foreground">{t("routerDetail.securitySummary", { findings: findings.length, decisions: new Set(findings.map((item) => item.trace.id)).size })}</p></div>
      <div className="flex max-w-full flex-wrap gap-1 rounded-lg border bg-card p-1 lg:flex-nowrap lg:justify-end" role="group" aria-label={t("routerDetail.filterSeverity")}>{filters.map((filter) => <Button key={filter} type="button" size="sm" variant={severity === filter ? "secondary" : "ghost"} className="min-h-11 shrink-0 gap-1 px-2.5" aria-pressed={severity === filter} onClick={() => setSeverity(filter)}><span>{filter === "all" ? t("routerDetail.allSeverities") : t(`routerDetail.severity.${filter}`)}</span><span className="font-mono text-[10px] text-muted-foreground">{counts[filter]}</span></Button>)}</div>
    </div>
    <Card className="shadow-none">
      <CardHeader className="border-b"><div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-red-50 text-red-700"><ShieldAlert className="size-4" /></span><div><CardTitle>{t("routerDetail.findings")}</CardTitle><CardDescription>{t("routerDetail.findingsPrivacy")}</CardDescription></div></div></CardHeader>
      <CardContent className="p-0">
        {loading ? <Skeleton className="m-4 h-44 rounded-lg" /> : error ? <div className="p-4"><ErrorNotice error={error} /></div> : visibleFindings.length ? <div className="divide-y">{visibleFindings.map(({ trace, finding }) => <button key={`${trace.id}:${finding.id}`} type="button" className="flex min-h-20 w-full items-start gap-4 px-4 py-4 text-left outline-none hover:bg-muted/35 focus-visible:bg-muted/35 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30" onClick={() => onInspect(trace)}><SeverityBadge severity={finding.severity} /><span className="min-w-0 flex-1"><strong className="block truncate text-sm">{findingTitle(finding, policies)}</strong><span className="mt-1 block truncate text-xs text-muted-foreground">{finding.detail}</span><span className="mt-2 block font-mono text-[11px] text-muted-foreground">{finding.policy_id ?? "—"}{finding.rule_id ? ` · ${finding.rule_id}` : ""}</span></span><span className="hidden shrink-0 text-right sm:block"><time className="block font-mono text-xs text-muted-foreground">{new Date(trace.created_at).toLocaleString(i18n.language)}</time><span className="mt-1 block text-xs text-muted-foreground">{finding.confidence === null ? "—" : `${Math.round(finding.confidence * 100)}%`} · {trace.phase} · {trace.latency_ms} ms</span></span><ArrowUpRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" /></button>)}</div> : <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center"><span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground"><ShieldCheck className="size-5" /></span><p className="mt-3 text-sm font-medium">{t(findings.length ? "routerDetail.noMatchingFindings" : evidenceUnavailable ? "routerDetail.evidenceNotCollected" : "routerDetail.noSecurityTitle")}</p><p className="mt-1 max-w-lg text-xs leading-5 text-muted-foreground">{t(findings.length ? "routerDetail.noMatchingFindingsDescription" : evidenceUnavailable ? "routerDetail.evidenceNotCollectedDescription" : "routerDetail.noSecurityDescription")}</p></div>}
      </CardContent>
    </Card>
  </div>;
}

function RouterBindingView({ router, endpoint, guardrailName, version, loading }: { router: Router; endpoint?: Endpoint; guardrailName?: string; version?: GuardrailVersionDetail; loading: boolean }) {
  const { t, i18n } = useTranslation();
  if (loading) return <Skeleton className="h-[32rem] rounded-xl" />;
  return <div className="space-y-4">
    <div><h2 className="text-base font-semibold">{t("routerDetail.bindingTitle")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("routerDetail.bindingDescription")}</p></div>
    <dl className="grid overflow-hidden rounded-lg border bg-card sm:grid-cols-2 xl:grid-cols-4">
      <ContextFact label={t("routerDetail.routerId")} value={router.id} mono />
      <ContextFact label={t("routerDetail.routeOrder")} value={String(router.route_order).padStart(2, "0")} mono />
      <ContextFact label={t("routerDetail.updatedAt")} value={new Date(router.updated_at).toLocaleString(i18n.language)} />
      <ContextFact label={t("routerDetail.status")} value={t(router.enabled ? "routerDetail.enabled" : "routerDetail.paused")} />
    </dl>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="shadow-none"><CardHeader><div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Building2 className="size-4" /></span><div><CardTitle>{t("routerDetail.trafficSource")}</CardTitle><CardDescription>{t("routerDetail.trafficSourceDescription")}</CardDescription></div></div></CardHeader><CardContent><dl className="grid gap-4 sm:grid-cols-2"><InlineFact label={t("routerDetail.endpoint")} value={endpoint?.name ?? t("routerDetail.directRuntime")} /><InlineFact label={t("routerDetail.protocol")} value={endpoint?.protocol.toUpperCase() ?? "DIRECT"} /><InlineFact label={t("routerDetail.adapter")} value={endpoint?.adapter_id ?? t("routerDetail.localRuntime")} mono /><InlineFact label={t("routerDetail.endpointStatus")} value={endpoint?.setup_status ?? "ready"} /></dl></CardContent></Card>
      <Card className="shadow-none"><CardHeader><div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><LockKeyhole className="size-4" /></span><div><CardTitle>{t("routerDetail.immutableGuardrail")}</CardTitle><CardDescription>{t("routerDetail.immutableGuardrailDescription")}</CardDescription></div></div></CardHeader><CardContent><dl className="grid gap-4 sm:grid-cols-2"><InlineFact label={t("routerDetail.guardrail")} value={guardrailName ?? router.guardrail_id} /><InlineFact label={t("routerDetail.version")} value={router.guardrail_version} mono /><InlineFact label={t("routerDetail.runtimeProfile")} value={version?.runtime_profile ?? "—"} mono /><InlineFact label={t("routerDetail.compiler")} value={version?.compiler_version ?? "—"} mono /></dl><div className="mt-4 rounded-lg border bg-muted/25 p-3"><p className="text-xs text-muted-foreground">{t("routerDetail.configChecksum")}</p><div className="mt-0.5"><CopyableChecksum value={version?.config_checksum} /></div></div><Button asChild variant="outline" className="mt-4"><Link to="/guardrails/$guardrailId" params={{ guardrailId: router.guardrail_id }}><ShieldCheck />{t("routerDetail.openGuardrail")}<ArrowUpRight /></Link></Button></CardContent></Card>
    </div>
    {version ? <Card className="shadow-none"><CardHeader><CardTitle>{t("routerDetail.compiledRuntime")}</CardTitle><CardDescription>{t("routerDetail.compiledRuntimeDescription")}</CardDescription></CardHeader><CardContent><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><InlineFact label={t("routerDetail.colangVersion")} value={version.colang_version} mono /><InlineFact label={t("routerDetail.rails")} value={String(version.rails.length)} /><InlineFact label={t("routerDetail.actions")} value={String(version.actions.length)} /><InlineFact label={t("routerDetail.criticalPath")} value={`${version.estimated_critical_path_ms} ms`} /></div></CardContent></Card> : null}
  </div>;
}

function RouterTrafficView({ router, endpoint, canManage, onEdit }: { router: Router; endpoint?: Endpoint; canManage: boolean; onEdit: () => void }) {
  const { t } = useTranslation();
  const allTraffic = !router.traffic_scope.conditions.length;
  return <div className="space-y-4">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h2 className="text-base font-semibold">{t("routerDetail.trafficTitle")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("routerDetail.trafficDescription", { endpoint: endpoint?.name ?? t("routerDetail.directRuntime") })}</p></div>{canManage && !router.system_managed ? <Button onClick={onEdit}><Pencil />{t("routerDetail.editSelector")}</Button> : null}</div>
    <Card className="shadow-none"><CardHeader><div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">{allTraffic ? <Route className="size-4" /> : <Filter className="size-4" />}</span><div><CardTitle>{t(allTraffic ? "routers.allTraffic" : "routers.filteredTraffic")}</CardTitle><CardDescription>{t(allTraffic ? "routerDetail.allTrafficContext" : "routerDetail.filteredTrafficContext", { endpoint: endpoint?.name ?? t("routerDetail.directRuntime") })}</CardDescription></div></div></CardHeader><CardContent><div className="rounded-lg border bg-muted/20 p-4"><TrafficScopeBadges router={router} /></div><div className="mt-4 grid gap-3 sm:grid-cols-3"><InlineFact label={t("routerDetail.endpoint")} value={endpoint?.name ?? t("routerDetail.directRuntime")} /><InlineFact label={t("routerDetail.routeOrder")} value={String(router.route_order).padStart(2, "0")} mono /><InlineFact label={t("routerDetail.guardrail")} value={`${router.guardrail_id} · ${router.guardrail_version}`} mono /></div></CardContent></Card>
    <InfoNotice title={t("routerDetail.selectorBoundaryTitle")}>{t("routerDetail.selectorBoundaryDescription")}</InfoNotice>
  </div>;
}

function EditTrafficScopeSheet({ router, endpoint, definitions, loading, error, open, onOpenChange, onSaved }: { router: Router; endpoint?: Endpoint; definitions: TrafficScopeField[]; loading: boolean; error: unknown; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const scopedDefinitions = useMemo(() => filterDefinitionsForProtocol(definitions, endpoint?.protocol), [definitions, endpoint?.protocol]);
  const initialMode = router.traffic_scope.conditions.length ? "filtered" : "all";
  const [mode, setMode] = useState<"all" | "filtered">(initialMode);
  const [filterQuery, setFilterQuery] = useState<TrafficScopeQuery>(() => createTrafficScopeQuery(scopedDefinitions));
  useEffect(() => {
    if (!open || !scopedDefinitions.length) return;
    setMode(initialMode);
    setFilterQuery(initialMode === "filtered" ? fromTrafficScopeExpression(router.traffic_scope, scopedDefinitions) : createTrafficScopeQuery(scopedDefinitions));
  }, [router.traffic_scope, initialMode, open, scopedDefinitions]);
  const expression = mode === "all" ? { combinator: "and" as const, conditions: [] } : toTrafficScopeExpression(filterQuery, scopedDefinitions);
  const valid = mode === "all" || isTrafficScopeValid(filterQuery, scopedDefinitions);
  const mutation = useMutation({ mutationFn: () => updateRouterTrafficScope(router.id, expression), onSuccess: () => { toast.success(t("routerDetail.selectorUpdated")); onSaved(); }, onError: (mutationError) => toast.error(mutationError instanceof Error ? mutationError.message : t("routers.operationFailed")) });
  return <EntitySheet open={open} onOpenChange={onOpenChange} eyebrow={t("routerDetail.selectorEyebrow")} title={t("routerDetail.selectorSheetTitle")} description={t("routerDetail.selectorSheetDescription", { endpoint: endpoint?.name ?? t("routerDetail.directRuntime") })} width="xl" footer={<><Button variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button><Button className="min-h-11" disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? <LoaderCircle className="animate-spin" /> : <ListFilter />}{t(mutation.isPending ? "common.saving" : "routerDetail.saveSelector")}</Button></>}>
    <div className="grid gap-5">
      <InfoNotice title={t("routerDetail.immutableBoundaryTitle")}>{t("routerDetail.immutableBoundaryDescription")}</InfoNotice>
      <RadioGroup value={mode} onValueChange={(value) => setMode(value as "all" | "filtered")} className="grid gap-3 sm:grid-cols-2"><TrafficMode value="all" selected={mode === "all"} title={t("routers.allTraffic")} description={t("routers.allTrafficDescription")} /><TrafficMode value="filtered" selected={mode === "filtered"} title={t("routers.filteredTraffic")} description={t("routers.filteredTrafficDescription")} /></RadioGroup>
      {loading ? <Skeleton className="h-72 rounded-lg" /> : error ? <ErrorNotice error={error} /> : mode === "filtered" ? <TrafficScopeBuilder definitions={scopedDefinitions} query={filterQuery} onQueryChange={setFilterQuery} /> : <InfoNotice title={t("routers.catchAllTitle")}>{t("routerDetail.allTrafficLastRoute")}</InfoNotice>}
    </div>
  </EntitySheet>;
}

function TraceDetailSheet({ trace, router, endpoint, guardrailName, policies, open, onOpenChange }: { trace: RouterRuntimeTrace | null; router: Router; endpoint?: Endpoint; guardrailName?: string; policies: Policy[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, i18n } = useTranslation();
  if (!trace) return null;
  return <EntitySheet open={open} onOpenChange={onOpenChange} eyebrow={t("routerDetail.traceEyebrow")} title={t("routerDetail.traceTitle")} description={trace.id} width="xl" footer={<Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>}>
    <div className="grid gap-5">
      <dl className="grid overflow-hidden rounded-lg border sm:grid-cols-2 lg:grid-cols-4"><ContextFact label={t("routerDetail.time")} value={new Date(trace.created_at).toLocaleString(i18n.language)} /><ContextFact label={t("routerDetail.source")} value={endpoint?.name ?? t("routerDetail.directRuntime")} /><ContextFact label={t("routerDetail.guardrail")} value={`${guardrailName ?? router.guardrail_id} · ${trace.guardrail_version ?? router.guardrail_version}`} /><ContextFact label={t("routerDetail.decision")} value={`${trace.outcome} · ${trace.action}`} /></dl>
      <section><div className="mb-3"><h3 className="text-sm font-semibold">{t("routerDetail.findings")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("routerDetail.findingsPrivacy")}</p></div>{trace.findings.length ? <div className="grid gap-3">{trace.findings.map((finding) => <div key={finding.id} className="rounded-lg border p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={finding.severity} /><strong className="text-sm">{findingTitle(finding, policies)}</strong></div><p className="mt-2 text-xs leading-5 text-muted-foreground">{finding.detail}</p></div><span className="font-mono text-xs text-muted-foreground">{finding.confidence === null ? "—" : `${Math.round(finding.confidence * 100)}%`}</span></div><dl className="mt-4 grid gap-3 sm:grid-cols-3"><InlineFact label={t("routerDetail.policy")} value={finding.policy_id ?? "—"} mono /><InlineFact label={t("routerDetail.rule")} value={finding.rule_id ?? "—"} mono /><InlineFact label={t("routerDetail.action")} value={finding.recommended_action} mono /></dl></div>)}</div> : <EmptyState title={t(trace.evidence_status === "not_collected" ? "routerDetail.evidenceNotCollected" : "routerDetail.noFinding")} description={t(trace.evidence_status === "not_collected" ? "routerDetail.evidenceNotCollectedDescription" : "routerDetail.noFindingDescription")} />}</section>
      <section><div className="mb-3"><h3 className="text-sm font-semibold">{t("routerDetail.executionTrace")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("routerDetail.executionTraceDescription")}</p></div>{trace.steps.length ? <ol className="relative ml-4 border-l">{trace.steps.map((step) => <li key={step.id} className="relative pb-5 pl-6 last:pb-0"><span className="absolute -left-[13px] top-0 grid size-6 place-items-center rounded-full border bg-background text-primary">{step.kind === "rail" ? <Workflow className="size-3" /> : <FileCode2 className="size-3" />}</span><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-sm font-medium">{step.name}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{step.action_name ?? step.flow_name ?? step.kind}{step.action_version ? `@${step.action_version}` : ""}</p></div><span className="flex items-center gap-2 text-xs text-muted-foreground"><StateBadge state={step.outcome} /><Clock3 className="size-3" />{step.latency_ms} ms</span></div></li>)}</ol> : <EmptyState title={t(trace.evidence_status === "not_collected" ? "routerDetail.evidenceNotCollected" : "routerDetail.noStepsTitle")} description={t(trace.evidence_status === "not_collected" ? "routerDetail.evidenceNotCollectedDescription" : "routerDetail.noStepsDescription")} />}</section>
    </div>
  </EntitySheet>;
}

function RuntimeStat({ label, value, detail, danger = false, onClick, actionLabel }: { label: string; value: string; detail: string; danger?: boolean; onClick?: () => void; actionLabel?: string }) { return <div className={`relative border-b px-4 py-3 last:border-b-0 sm:[&:nth-child(odd)]:border-r xl:border-b-0 xl:border-r xl:last:border-r-0 ${onClick ? "group hover:bg-muted/25" : ""}`}><dt className="text-[11px] text-muted-foreground">{label}</dt><dd className={`mt-0.5 font-display text-xl font-semibold tabular-nums ${danger ? "text-red-700" : ""}`}>{value}</dd><p className={`mt-0.5 text-[11px] ${onClick ? "text-primary" : "text-muted-foreground"}`}>{detail}</p>{onClick ? <button type="button" className="absolute inset-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40" aria-label={actionLabel} onClick={onClick}><ArrowUpRight className="absolute right-3 top-3 size-3.5 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground" /></button> : null}</div>; }
function ContextFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="border-b p-4 last:border-b-0 sm:border-r sm:[&:nth-child(even)]:border-r-0 lg:border-b-0 lg:[&:nth-child(even)]:border-r lg:last:border-r-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className={`mt-1 break-all text-sm font-medium ${mono ? "font-mono text-xs" : ""}`}>{value}</dd></div>; }
function InlineFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className={`mt-1 break-all text-sm font-medium ${mono ? "font-mono text-xs" : ""}`}>{value}</dd></div>; }
function TrafficMode({ value, selected, title, description }: { value: string; selected: boolean; title: string; description: string }) { return <label className={`flex min-h-24 cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ${selected ? "border-primary bg-primary/[0.04]" : "bg-card hover:bg-muted/35"}`}><RadioGroupItem value={value} className="mt-0.5" /><span><span className="block text-sm font-medium">{title}</span><span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">{description}</span></span></label>; }
function SeverityBadge({ severity }: { severity: RouterTraceFinding["severity"] }) { const { t } = useTranslation(); const classes = { critical: "border-red-200 bg-red-50 text-red-700", high: "border-orange-200 bg-orange-50 text-orange-700", medium: "border-amber-200 bg-amber-50 text-amber-700", low: "border-slate-200 bg-slate-50 text-slate-700" }[severity]; return <Badge variant="outline" className={classes}>{t(`routerDetail.severity.${severity}`)}</Badge>; }
function findingTitle(finding: RouterTraceFinding | undefined, policies: Policy[]) { if (!finding) return "—"; const policy = policies.find((item) => item.id === finding.policy_id); const rule = policy?.rules.find((item) => item.id === finding.rule_id); return rule?.name ?? policy?.name ?? finding.rule_id ?? finding.risk.replaceAll("_", " "); }
