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
  getDeployment,
  deleteDeployment,
  getDeploymentDeletionImpact,
  getDeploymentTraces,
  getGuardrailVersion,
  getGuardrails,
  getIntegrations,
  getMetrics,
  getPolicies,
  getTrafficScopeFields,
  updateDeploymentTrafficScope,
  type Deployment,
  type DeploymentDeletionImpact,
  type DeploymentRuntimeTrace,
  type DeploymentTraceFinding,
  type GuardrailVersionDetail,
  type Integration,
  type Metrics,
  type Policy,
  type TrafficScopeField,
} from "@/lib/api";
import { filterDefinitionsForProtocol, TrafficScopeBadges } from "@/routes/deployments";

const EMPTY_FIELDS: TrafficScopeField[] = [];

type DeploymentDeletionConfirmation = {
  reason: string;
  confirm_recent_traffic: boolean;
  confirmation_name?: string;
};

export function DeploymentDetailPage() {
  const { t } = useTranslation();
  const { deploymentId } = useParams({ strict: false }) as { deploymentId: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const auth = useAuth();
  const canManage = auth.user?.role === "admin";
  const [section, setSection] = useState("runtime");
  const [editScopeOpen, setEditScopeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedTrace, setSelectedTrace] = useState<DeploymentRuntimeTrace | null>(null);
  const deploymentQuery = useQuery({ queryKey: queryKeys.deployment(deploymentId), queryFn: () => getDeployment(deploymentId) });
  const guardrailsQuery = useQuery({ queryKey: queryKeys.guardrails, queryFn: getGuardrails });
  const integrationsQuery = useQuery({ queryKey: queryKeys.integrations, queryFn: getIntegrations });
  const policiesQuery = useQuery({ queryKey: queryKeys.policies, queryFn: getPolicies });
  const fieldsQuery = useQuery({ queryKey: queryKeys.trafficScopeFields, queryFn: getTrafficScopeFields });
  const tracesQuery = useQuery({
    queryKey: queryKeys.deploymentTraces(deploymentId),
    queryFn: () => getDeploymentTraces(deploymentId),
    refetchInterval: 15_000,
  });
  const metricsQuery = useQuery({
    queryKey: queryKeys.metricsScope({ deploymentId, window: "24h" }),
    queryFn: () => getMetrics({ deploymentId, window: "24h" }),
  });
  const deletionImpactQuery = useQuery({
    queryKey: queryKeys.deploymentDeletionImpact(deploymentId),
    queryFn: () => getDeploymentDeletionImpact(deploymentId),
    enabled: deleteOpen,
    staleTime: 0,
  });
  const deleteMutation = useMutation({
    mutationFn: (confirmation: DeploymentDeletionConfirmation) => deleteDeployment(deploymentId, confirmation),
    onSuccess: async () => {
      toast.success(t("deploymentDetail.deleteSucceeded"));
      await queryClient.cancelQueries({ queryKey: queryKeys.deployment(deploymentId) });
      queryClient.removeQueries({ queryKey: queryKeys.deployment(deploymentId) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.deployments, exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.metrics }),
        queryClient.invalidateQueries({ queryKey: queryKeys.auditEvents }),
        queryClient.invalidateQueries({ queryKey: queryKeys.systemStatus }),
      ]);
      navigate({ to: "/deployments" });
    },
    onError: async () => { await deletionImpactQuery.refetch(); },
  });
  const deployment = deploymentQuery.data;
  const guardrail = guardrailsQuery.data?.items.find((item) => item.id === deployment?.guardrail_id);
  const integration = integrationsQuery.data?.items.find((item) => item.id === deployment?.integration_id);
  const versionQuery = useQuery({
    queryKey: queryKeys.guardrailVersion(deployment?.guardrail_id ?? "", deployment?.guardrail_version ?? ""),
    queryFn: () => getGuardrailVersion(deployment!.guardrail_id, deployment!.guardrail_version),
    enabled: Boolean(deployment?.guardrail_id && deployment.guardrail_version),
  });

  async function refreshDeployment() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.deployment(deploymentId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.deployments }),
      queryClient.invalidateQueries({ queryKey: queryKeys.metrics }),
      queryClient.invalidateQueries({ queryKey: queryKeys.deploymentTraces(deploymentId) }),
    ]);
  }

  if (deploymentQuery.isLoading) return <Skeleton className="mt-8 h-[38rem] rounded-xl" />;
  if (deploymentQuery.error || !deployment) return <div className="py-8"><ErrorNotice error={deploymentQuery.error ?? new Error(t("deploymentDetail.notFound"))} /></div>;
  const traces = tracesQuery.data?.items ?? [];
  const policies = policiesQuery.data?.items ?? [];
  const findingCount = traces.reduce((count, trace) => count + trace.findings.length, 0);

  return (
    <section className="py-6 sm:py-8">
      <Link to="/deployments" className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />{t("deploymentDetail.back")}</Link>
      <div className="mt-3 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-2xl font-semibold tracking-[-0.015em] sm:text-3xl">{deployment.name}</h1>
            <StateBadge state={deployment.enabled ? "protected" : "paused"} />
            <Badge variant="outline">{t("deployments.version", { version: deployment.guardrail_version })}</Badge>
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{t("deploymentDetail.description", { integration: integration?.name ?? t("deploymentDetail.directRuntime"), guardrail: guardrail?.name ?? deployment.guardrail_id })}</p>
        </div>
        {canManage && !deployment.system_managed ? <div className="flex flex-wrap gap-2">
          <Button className="min-h-11" variant="outline" onClick={() => { setSection("traffic"); setEditScopeOpen(true); }}><Pencil />{t("deploymentDetail.editSelector")}</Button>
          <Button className="min-h-11 text-destructive hover:bg-destructive/10 hover:text-destructive" variant="outline" onClick={() => {
            deleteMutation.reset();
            queryClient.removeQueries({ queryKey: queryKeys.deploymentDeletionImpact(deploymentId), exact: true });
            setDeleteOpen(true);
          }}><Trash2 />{t("deploymentDetail.deleteAction")}</Button>
        </div> : null}
      </div>

      <Tabs value={section} onValueChange={setSection} className="mt-7">
        <div className="overflow-x-auto">
          <TabsList className="min-w-max" aria-label={t("deploymentDetail.detailViews")}>
            <TabsTrigger value="runtime"><Activity />{t("deploymentDetail.runtimeTab")}</TabsTrigger>
            <TabsTrigger value="security"><ShieldAlert />{t("deploymentDetail.securityTab")}<Badge variant="outline" className="ml-1 min-w-5 justify-center px-1.5 font-mono text-[10px]">{findingCount}</Badge></TabsTrigger>
            <TabsTrigger value="binding"><LockKeyhole />{t("deploymentDetail.bindingTab")}</TabsTrigger>
            <TabsTrigger value="traffic"><ListFilter />{t("deploymentDetail.trafficTab")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="runtime" className="pt-5">
          <DeploymentRuntimeView
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
          <DeploymentSecurityView
            traces={traces}
            loading={tracesQuery.isLoading}
            error={tracesQuery.error}
            policies={policies}
            onInspect={setSelectedTrace}
          />
        </TabsContent>
        <TabsContent value="binding" className="pt-5">
          <DeploymentBindingView deployment={deployment} integration={integration} guardrailName={guardrail?.name} version={versionQuery.data} loading={versionQuery.isLoading || guardrailsQuery.isLoading || integrationsQuery.isLoading} />
        </TabsContent>
        <TabsContent value="traffic" className="pt-5">
          <DeploymentTrafficView deployment={deployment} integration={integration} canManage={canManage} onEdit={() => setEditScopeOpen(true)} />
        </TabsContent>
      </Tabs>

      <EditTrafficScopeSheet
        deployment={deployment}
        integration={integration}
        definitions={fieldsQuery.data?.items ?? EMPTY_FIELDS}
        loading={fieldsQuery.isLoading}
        error={fieldsQuery.error}
        open={editScopeOpen}
        onOpenChange={setEditScopeOpen}
        onSaved={async () => { setEditScopeOpen(false); await refreshDeployment(); }}
      />
      <TraceDetailSheet trace={selectedTrace} deployment={deployment} integration={integration} guardrailName={guardrail?.name} policies={policies} open={Boolean(selectedTrace)} onOpenChange={(open) => { if (!open) setSelectedTrace(null); }} />
      <DeleteDeploymentSheet
        deployment={deployment}
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

export function DeleteDeploymentSheet({ deployment, open, impact, loading, deleting, error, onOpenChange, onRetry, onConfirm }: {
  deployment: Deployment;
  open: boolean;
  impact?: DeploymentDeletionImpact;
  loading: boolean;
  deleting: boolean;
  error: Error | null;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  onConfirm: (confirmation: DeploymentDeletionConfirmation) => void;
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
    entityName={deployment.name}
    loading={loading}
    ready={telemetryFresh}
    deleting={deleting}
    error={impact && !telemetryFresh ? new Error(t("deploymentDetail.deleteTelemetryStale")) : error}
    requiresConfirmation={requiresSecondConfirmation}
    impactItems={impact ? [
      { label: t("deploymentDetail.recentIncomingRequests", { minutes: impact.window_minutes }), value: impact.incoming_request_count.toLocaleString(i18n.language) },
      { label: t("deploymentDetail.activeRouteAffected"), value: impact.active_deployment_count.toLocaleString(i18n.language) },
    ] : []}
    copy={{
      eyebrow: t("deploymentDetail.deleteEyebrow"),
      title: t("deploymentDetail.deleteDialogTitle"),
      description: t("deploymentDetail.deleteDialogDescription", { name: deployment.name }),
      protectedMessage: t("deploymentDetail.recentTrafficWarning"),
      clearMessage: t("deploymentDetail.noRecentTraffic"),
      retentionNote: t("deploymentDetail.deleteRetentionNote"),
      continueLabel: t("deploymentDetail.continueDelete"),
      deleteLabel: t("deploymentDetail.deleteConfirm"),
      deletingLabel: t("deploymentDetail.deleting"),
      confirmTitle: t("deploymentDetail.deleteRecentTrafficTitle"),
      confirmDescription: t("deploymentDetail.deleteRecentTrafficDescription", { count: impact?.incoming_request_count ?? 0, minutes: impact?.window_minutes ?? 30 }),
      confirmWarning: t("deploymentDetail.deleteStopsTraffic"),
      typeNameLabel: t("deploymentDetail.typeNameToConfirm", { name: deployment.name }),
      protectedDeleteLabel: t("deploymentDetail.deleteDespiteTraffic"),
      cancelLabel: t("common.cancel"),
      backLabel: t("common.back"),
      retryLabel: t("common.retry"),
      reasonLabel: t("deploymentDetail.deleteReason"),
      reasonPlaceholder: t("deploymentDetail.deleteReasonPlaceholder"),
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

function DeploymentRuntimeView({ metrics, metricsLoading, metricsError, traces, tracesLoading, tracesError, policies, onInspect, onOpenSecurity }: { metrics?: Metrics; metricsLoading: boolean; metricsError: unknown; traces: DeploymentRuntimeTrace[]; tracesLoading: boolean; tracesError: unknown; policies: Policy[]; onInspect: (trace: DeploymentRuntimeTrace) => void; onOpenSecurity: () => void }) {
  const { t, i18n } = useTranslation();
  const criticalCount = traces.reduce((count, trace) => count + trace.findings.filter((finding) => finding.severity === "critical").length, 0);
  return (
    <div className="space-y-4">
      <div><h2 className="text-base font-semibold">{t("deploymentDetail.runtimeTitle")}</h2><p className="mt-0.5 text-xs text-muted-foreground">{t("deploymentDetail.runtimeDescription")}</p></div>
      {metricsError ? <ErrorNotice error={metricsError} /> : null}
      {metricsLoading ? <Skeleton className="h-28 rounded-lg" /> : metrics ? (
        <dl className="grid overflow-hidden rounded-lg border border-border/65 bg-card sm:grid-cols-2 xl:grid-cols-4">
          <RuntimeStat label={t("deploymentDetail.protectedTraffic")} value={metrics.total_decisions.toLocaleString(i18n.language)} detail={t("deploymentDetail.last24Hours")} />
          <RuntimeStat label={t("deploymentDetail.interventionRate")} value={metrics.total_decisions ? `${metrics.intervention_rate}%` : "—"} detail={t("deploymentDetail.interventionDetail", { blocked: metrics.blocked, transformed: metrics.intervened })} />
          <RuntimeStat label={t("deploymentDetail.criticalFindings")} value={criticalCount.toLocaleString(i18n.language)} detail={t("deploymentDetail.openSecurityFindings")} danger={criticalCount > 0} onClick={onOpenSecurity} actionLabel={t("deploymentDetail.viewSecurityFindings")} />
          <RuntimeStat label={t("deploymentDetail.p95Latency")} value={metrics.total_decisions ? `${metrics.runtime_p95_ms} ms` : "—"} detail={t("deploymentDetail.last24Hours")} />
        </dl>
      ) : null}

      <DeploymentRuntimeEventTable traces={traces} loading={tracesLoading} error={tracesError} policies={policies} onInspect={onInspect} />
    </div>
  );
}

export function DeploymentRuntimeEventTable({ traces, loading, error, policies, onInspect }: { traces: DeploymentRuntimeTrace[]; loading: boolean; error: unknown; policies: Policy[]; onInspect: (trace: DeploymentRuntimeTrace) => void }) {
  const { t, i18n } = useTranslation();
  return <Card className="gap-0 overflow-hidden py-0 shadow-none">
    <header className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
      <div><div className="flex items-center gap-2"><h3 className="text-sm font-semibold">{t("deploymentDetail.eventLog")}</h3><Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px]">{traces.length}</Badge></div><p className="mt-0.5 text-xs text-muted-foreground">{t("deploymentDetail.eventLogDescription")}</p></div>
      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="size-1.5 rounded-full bg-emerald-500" />{t("deploymentDetail.liveEvents")}</span>
    </header>
    {loading ? <div className="space-y-px bg-border">{Array.from({ length: 8 }).map((_, index) => <Skeleton key={index} className="h-11 w-full rounded-none" />)}</div> : error ? <div className="p-4"><ErrorNotice error={error} /></div> : traces.length ? <div className="max-h-[30rem] overflow-auto [scrollbar-gutter:stable]"><table className="w-full min-w-[52rem] table-fixed text-left text-xs" aria-label={t("deploymentDetail.eventLog")}><thead className="sticky top-0 z-10 border-b bg-muted/95 text-[11px] text-muted-foreground backdrop-blur-sm"><tr><th scope="col" className="h-8 w-44 px-3 font-medium">{t("deploymentDetail.time")}</th><th scope="col" className="h-8 w-20 px-3 font-medium">{t("deploymentDetail.phase")}</th><th scope="col" className="h-8 w-24 px-3 font-medium">{t("deploymentDetail.decision")}</th><th scope="col" className="h-8 px-3 font-medium">{t("deploymentDetail.finding")}</th><th scope="col" className="h-8 w-20 px-3 text-right font-medium">{t("deploymentDetail.latency")}</th><th scope="col" className="h-8 w-12 px-0"><span className="sr-only">{t("deploymentDetail.inspect")}</span></th></tr></thead><tbody className="divide-y">{traces.map((trace) => {
      const timestamp = formatEventTimestamp(trace.created_at, i18n.language);
      return <tr key={trace.id} className="h-11 transition-colors hover:bg-muted/35"><td className="px-3 font-mono text-[11px] tabular-nums whitespace-nowrap" title={new Date(trace.created_at).toLocaleString(i18n.language)}><span className="text-muted-foreground">{timestamp.date}</span> {timestamp.time}</td><td className="px-3 font-mono text-[10px] uppercase text-muted-foreground">{trace.phase}</td><td className="px-3"><StateBadge state={trace.outcome} /></td><td className="truncate px-3">{trace.severity ? <span className="inline-flex max-w-full items-center gap-2"><SeverityBadge severity={trace.severity} /><span className="truncate text-[11px]">{findingTitle(trace.findings[0], policies)}</span></span> : <span className="text-[11px] text-muted-foreground">{t(trace.evidence_status === "not_collected" ? "deploymentDetail.evidenceNotCollected" : "deploymentDetail.noFinding")}</span>}</td><td className="px-3 text-right font-mono text-[11px] tabular-nums">{trace.latency_ms} ms</td><td className="p-0 text-center"><Button type="button" size="icon" variant="ghost" className="size-11 rounded-none" aria-label={t("deploymentDetail.inspectTrace", { id: trace.id })} onClick={() => onInspect(trace)}><ArrowUpRight className="size-3.5" /></Button></td></tr>;
    })}</tbody></table></div> : <div className="p-4"><EmptyState title={t("deploymentDetail.noEventsTitle")} description={t("deploymentDetail.noEventsDescription")} /></div>}
  </Card>;
}

type FindingSeverityFilter = "all" | DeploymentTraceFinding["severity"];

function DeploymentSecurityView({ traces, loading, error, policies, onInspect }: { traces: DeploymentRuntimeTrace[]; loading: boolean; error: unknown; policies: Policy[]; onInspect: (trace: DeploymentRuntimeTrace) => void }) {
  const { t, i18n } = useTranslation();
  const [severity, setSeverity] = useState<FindingSeverityFilter>("all");
  const findings = useMemo(() => traces.flatMap((trace) => trace.findings.map((finding) => ({ trace, finding }))), [traces]);
  const counts = useMemo(() => ({
    all: findings.length,
    critical: findings.filter((item) => item.finding.severity === "critical").length,
    high: findings.filter((item) => item.finding.severity === "high").length,
    medium: findings.filter((item) => item.finding.severity === "medium").length,
    low: findings.filter((item) => item.finding.severity === "low").length,
  }), [findings]);
  const visibleFindings = severity === "all" ? findings : findings.filter((item) => item.finding.severity === severity);
  const filters: FindingSeverityFilter[] = ["all", "critical", "high", "medium", "low"];
  const evidenceUnavailable = traces.length > 0 && traces.some((trace) => trace.evidence_status === "not_collected");

  return <div className="space-y-4">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div><h2 className="text-base font-semibold">{t("deploymentDetail.securityTitle")}</h2><p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("deploymentDetail.securityDescription")}</p><p className="mt-2 text-xs text-muted-foreground">{t("deploymentDetail.securitySummary", { findings: findings.length, decisions: new Set(findings.map((item) => item.trace.id)).size })}</p></div>
      <div className="flex max-w-full flex-wrap gap-1 rounded-lg border bg-card p-1 lg:flex-nowrap lg:justify-end" role="group" aria-label={t("deploymentDetail.filterSeverity")}>{filters.map((filter) => <Button key={filter} type="button" size="sm" variant={severity === filter ? "secondary" : "ghost"} className="min-h-11 shrink-0 gap-1 px-2.5" aria-pressed={severity === filter} onClick={() => setSeverity(filter)}><span>{filter === "all" ? t("deploymentDetail.allSeverities") : t(`deploymentDetail.severity.${filter}`)}</span><span className="font-mono text-[10px] text-muted-foreground">{counts[filter]}</span></Button>)}</div>
    </div>
    <Card className="shadow-none">
      <CardHeader className="border-b"><div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-red-50 text-red-700"><ShieldAlert className="size-4" /></span><div><CardTitle>{t("deploymentDetail.findings")}</CardTitle><CardDescription>{t("deploymentDetail.findingsPrivacy")}</CardDescription></div></div></CardHeader>
      <CardContent className="p-0">
        {loading ? <Skeleton className="m-4 h-44 rounded-lg" /> : error ? <div className="p-4"><ErrorNotice error={error} /></div> : visibleFindings.length ? <div className="divide-y">{visibleFindings.map(({ trace, finding }) => <button key={`${trace.id}:${finding.id}`} type="button" className="flex min-h-20 w-full items-start gap-4 px-4 py-4 text-left outline-none hover:bg-muted/35 focus-visible:bg-muted/35 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30" onClick={() => onInspect(trace)}><SeverityBadge severity={finding.severity} /><span className="min-w-0 flex-1"><strong className="block truncate text-sm">{findingTitle(finding, policies)}</strong><span className="mt-1 block truncate text-xs text-muted-foreground">{finding.detail}</span><span className="mt-2 block font-mono text-[11px] text-muted-foreground">{finding.policy_id ?? "—"}{finding.rule_id ? ` · ${finding.rule_id}` : ""}</span></span><span className="hidden shrink-0 text-right sm:block"><time className="block font-mono text-xs text-muted-foreground">{new Date(trace.created_at).toLocaleString(i18n.language)}</time><span className="mt-1 block text-xs text-muted-foreground">{finding.confidence === null ? "—" : `${Math.round(finding.confidence * 100)}%`} · {trace.phase} · {trace.latency_ms} ms</span></span><ArrowUpRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" /></button>)}</div> : <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center"><span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground"><ShieldCheck className="size-5" /></span><p className="mt-3 text-sm font-medium">{t(findings.length ? "deploymentDetail.noMatchingFindings" : evidenceUnavailable ? "deploymentDetail.evidenceNotCollected" : "deploymentDetail.noSecurityTitle")}</p><p className="mt-1 max-w-lg text-xs leading-5 text-muted-foreground">{t(findings.length ? "deploymentDetail.noMatchingFindingsDescription" : evidenceUnavailable ? "deploymentDetail.evidenceNotCollectedDescription" : "deploymentDetail.noSecurityDescription")}</p></div>}
      </CardContent>
    </Card>
  </div>;
}

function DeploymentBindingView({ deployment, integration, guardrailName, version, loading }: { deployment: Deployment; integration?: Integration; guardrailName?: string; version?: GuardrailVersionDetail; loading: boolean }) {
  const { t, i18n } = useTranslation();
  if (loading) return <Skeleton className="h-[32rem] rounded-xl" />;
  return <div className="space-y-4">
    <div><h2 className="text-base font-semibold">{t("deploymentDetail.bindingTitle")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("deploymentDetail.bindingDescription")}</p></div>
    <dl className="grid overflow-hidden rounded-lg border bg-card sm:grid-cols-2 xl:grid-cols-4">
      <ContextFact label={t("deploymentDetail.deploymentId")} value={deployment.id} mono />
      <ContextFact label={t("deploymentDetail.routeOrder")} value={String(deployment.route_order).padStart(2, "0")} mono />
      <ContextFact label={t("deploymentDetail.updatedAt")} value={new Date(deployment.updated_at).toLocaleString(i18n.language)} />
      <ContextFact label={t("deploymentDetail.status")} value={t(deployment.enabled ? "deploymentDetail.enabled" : "deploymentDetail.paused")} />
    </dl>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="shadow-none"><CardHeader><div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Building2 className="size-4" /></span><div><CardTitle>{t("deploymentDetail.trafficSource")}</CardTitle><CardDescription>{t("deploymentDetail.trafficSourceDescription")}</CardDescription></div></div></CardHeader><CardContent><dl className="grid gap-4 sm:grid-cols-2"><InlineFact label={t("deploymentDetail.integration")} value={integration?.name ?? t("deploymentDetail.directRuntime")} /><InlineFact label={t("deploymentDetail.protocol")} value={integration?.protocol.toUpperCase() ?? "DIRECT"} /><InlineFact label={t("deploymentDetail.adapter")} value={integration?.adapter_id ?? t("deploymentDetail.localRuntime")} mono /><InlineFact label={t("deploymentDetail.integrationStatus")} value={integration?.setup_status ?? "ready"} /></dl></CardContent></Card>
      <Card className="shadow-none"><CardHeader><div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><LockKeyhole className="size-4" /></span><div><CardTitle>{t("deploymentDetail.immutableGuardrail")}</CardTitle><CardDescription>{t("deploymentDetail.immutableGuardrailDescription")}</CardDescription></div></div></CardHeader><CardContent><dl className="grid gap-4 sm:grid-cols-2"><InlineFact label={t("deploymentDetail.guardrail")} value={guardrailName ?? deployment.guardrail_id} /><InlineFact label={t("deploymentDetail.version")} value={deployment.guardrail_version} mono /><InlineFact label={t("deploymentDetail.runtimeProfile")} value={version?.runtime_profile ?? "—"} mono /><InlineFact label={t("deploymentDetail.compiler")} value={version?.compiler_version ?? "—"} mono /></dl><div className="mt-4 rounded-lg border bg-muted/25 p-3"><p className="text-xs text-muted-foreground">{t("deploymentDetail.configChecksum")}</p><div className="mt-0.5"><CopyableChecksum value={version?.config_checksum} /></div></div><Button asChild variant="outline" className="mt-4"><Link to="/guardrails/$guardrailId" params={{ guardrailId: deployment.guardrail_id }}><ShieldCheck />{t("deploymentDetail.openGuardrail")}<ArrowUpRight /></Link></Button></CardContent></Card>
    </div>
    {version ? <Card className="shadow-none"><CardHeader><CardTitle>{t("deploymentDetail.compiledRuntime")}</CardTitle><CardDescription>{t("deploymentDetail.compiledRuntimeDescription")}</CardDescription></CardHeader><CardContent><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><InlineFact label={t("deploymentDetail.colangVersion")} value={version.colang_version} mono /><InlineFact label={t("deploymentDetail.rails")} value={String(version.rails.length)} /><InlineFact label={t("deploymentDetail.actions")} value={String(version.actions.length)} /><InlineFact label={t("deploymentDetail.criticalPath")} value={`${version.estimated_critical_path_ms} ms`} /></div></CardContent></Card> : null}
  </div>;
}

function DeploymentTrafficView({ deployment, integration, canManage, onEdit }: { deployment: Deployment; integration?: Integration; canManage: boolean; onEdit: () => void }) {
  const { t } = useTranslation();
  const allTraffic = !deployment.traffic_scope.conditions.length;
  return <div className="space-y-4">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h2 className="text-base font-semibold">{t("deploymentDetail.trafficTitle")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("deploymentDetail.trafficDescription", { integration: integration?.name ?? t("deploymentDetail.directRuntime") })}</p></div>{canManage && !deployment.system_managed ? <Button onClick={onEdit}><Pencil />{t("deploymentDetail.editSelector")}</Button> : null}</div>
    <Card className="shadow-none"><CardHeader><div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">{allTraffic ? <Route className="size-4" /> : <Filter className="size-4" />}</span><div><CardTitle>{t(allTraffic ? "deployments.allTraffic" : "deployments.filteredTraffic")}</CardTitle><CardDescription>{t(allTraffic ? "deploymentDetail.allTrafficContext" : "deploymentDetail.filteredTrafficContext", { integration: integration?.name ?? t("deploymentDetail.directRuntime") })}</CardDescription></div></div></CardHeader><CardContent><div className="rounded-lg border bg-muted/20 p-4"><TrafficScopeBadges deployment={deployment} /></div><div className="mt-4 grid gap-3 sm:grid-cols-3"><InlineFact label={t("deploymentDetail.integration")} value={integration?.name ?? t("deploymentDetail.directRuntime")} /><InlineFact label={t("deploymentDetail.routeOrder")} value={String(deployment.route_order).padStart(2, "0")} mono /><InlineFact label={t("deploymentDetail.guardrail")} value={`${deployment.guardrail_id} · ${deployment.guardrail_version}`} mono /></div></CardContent></Card>
    <InfoNotice title={t("deploymentDetail.selectorBoundaryTitle")}>{t("deploymentDetail.selectorBoundaryDescription")}</InfoNotice>
  </div>;
}

function EditTrafficScopeSheet({ deployment, integration, definitions, loading, error, open, onOpenChange, onSaved }: { deployment: Deployment; integration?: Integration; definitions: TrafficScopeField[]; loading: boolean; error: unknown; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const scopedDefinitions = useMemo(() => filterDefinitionsForProtocol(definitions, integration?.protocol), [definitions, integration?.protocol]);
  const initialMode = deployment.traffic_scope.conditions.length ? "filtered" : "all";
  const [mode, setMode] = useState<"all" | "filtered">(initialMode);
  const [filterQuery, setFilterQuery] = useState<TrafficScopeQuery>(() => createTrafficScopeQuery(scopedDefinitions));
  useEffect(() => {
    if (!open || !scopedDefinitions.length) return;
    setMode(initialMode);
    setFilterQuery(initialMode === "filtered" ? fromTrafficScopeExpression(deployment.traffic_scope, scopedDefinitions) : createTrafficScopeQuery(scopedDefinitions));
  }, [deployment.traffic_scope, initialMode, open, scopedDefinitions]);
  const expression = mode === "all" ? { combinator: "and" as const, conditions: [] } : toTrafficScopeExpression(filterQuery, scopedDefinitions);
  const valid = mode === "all" || isTrafficScopeValid(filterQuery, scopedDefinitions);
  const mutation = useMutation({ mutationFn: () => updateDeploymentTrafficScope(deployment.id, expression), onSuccess: () => { toast.success(t("deploymentDetail.selectorUpdated")); onSaved(); }, onError: (mutationError) => toast.error(mutationError instanceof Error ? mutationError.message : t("deployments.operationFailed")) });
  return <EntitySheet open={open} onOpenChange={onOpenChange} eyebrow={t("deploymentDetail.selectorEyebrow")} title={t("deploymentDetail.selectorSheetTitle")} description={t("deploymentDetail.selectorSheetDescription", { integration: integration?.name ?? t("deploymentDetail.directRuntime") })} width="xl" footer={<><Button variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button><Button className="min-h-11" disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? <LoaderCircle className="animate-spin" /> : <ListFilter />}{t(mutation.isPending ? "common.saving" : "deploymentDetail.saveSelector")}</Button></>}>
    <div className="grid gap-5">
      <InfoNotice title={t("deploymentDetail.immutableBoundaryTitle")}>{t("deploymentDetail.immutableBoundaryDescription")}</InfoNotice>
      <RadioGroup value={mode} onValueChange={(value) => setMode(value as "all" | "filtered")} className="grid gap-3 sm:grid-cols-2"><TrafficMode value="all" selected={mode === "all"} title={t("deployments.allTraffic")} description={t("deployments.allTrafficDescription")} /><TrafficMode value="filtered" selected={mode === "filtered"} title={t("deployments.filteredTraffic")} description={t("deployments.filteredTrafficDescription")} /></RadioGroup>
      {loading ? <Skeleton className="h-72 rounded-lg" /> : error ? <ErrorNotice error={error} /> : mode === "filtered" ? <TrafficScopeBuilder definitions={scopedDefinitions} query={filterQuery} onQueryChange={setFilterQuery} /> : <InfoNotice title={t("deployments.catchAllTitle")}>{t("deploymentDetail.allTrafficLastRoute")}</InfoNotice>}
    </div>
  </EntitySheet>;
}

function TraceDetailSheet({ trace, deployment, integration, guardrailName, policies, open, onOpenChange }: { trace: DeploymentRuntimeTrace | null; deployment: Deployment; integration?: Integration; guardrailName?: string; policies: Policy[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, i18n } = useTranslation();
  if (!trace) return null;
  return <EntitySheet open={open} onOpenChange={onOpenChange} eyebrow={t("deploymentDetail.traceEyebrow")} title={t("deploymentDetail.traceTitle")} description={trace.id} width="xl" footer={<Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>}>
    <div className="grid gap-5">
      <dl className="grid overflow-hidden rounded-lg border sm:grid-cols-2 lg:grid-cols-4"><ContextFact label={t("deploymentDetail.time")} value={new Date(trace.created_at).toLocaleString(i18n.language)} /><ContextFact label={t("deploymentDetail.source")} value={integration?.name ?? t("deploymentDetail.directRuntime")} /><ContextFact label={t("deploymentDetail.guardrail")} value={`${guardrailName ?? deployment.guardrail_id} · ${trace.guardrail_version ?? deployment.guardrail_version}`} /><ContextFact label={t("deploymentDetail.decision")} value={`${trace.outcome} · ${trace.action}`} /></dl>
      <section><div className="mb-3"><h3 className="text-sm font-semibold">{t("deploymentDetail.findings")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("deploymentDetail.findingsPrivacy")}</p></div>{trace.findings.length ? <div className="grid gap-3">{trace.findings.map((finding) => <div key={finding.id} className="rounded-lg border p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={finding.severity} /><strong className="text-sm">{findingTitle(finding, policies)}</strong></div><p className="mt-2 text-xs leading-5 text-muted-foreground">{finding.detail}</p></div><span className="font-mono text-xs text-muted-foreground">{finding.confidence === null ? "—" : `${Math.round(finding.confidence * 100)}%`}</span></div><dl className="mt-4 grid gap-3 sm:grid-cols-3"><InlineFact label={t("deploymentDetail.policy")} value={finding.policy_id ?? "—"} mono /><InlineFact label={t("deploymentDetail.rule")} value={finding.rule_id ?? "—"} mono /><InlineFact label={t("deploymentDetail.action")} value={finding.recommended_action} mono /></dl></div>)}</div> : <EmptyState title={t(trace.evidence_status === "not_collected" ? "deploymentDetail.evidenceNotCollected" : "deploymentDetail.noFinding")} description={t(trace.evidence_status === "not_collected" ? "deploymentDetail.evidenceNotCollectedDescription" : "deploymentDetail.noFindingDescription")} />}</section>
      <section><div className="mb-3"><h3 className="text-sm font-semibold">{t("deploymentDetail.executionTrace")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("deploymentDetail.executionTraceDescription")}</p></div>{trace.steps.length ? <ol className="relative ml-4 border-l">{trace.steps.map((step) => <li key={step.id} className="relative pb-5 pl-6 last:pb-0"><span className="absolute -left-[13px] top-0 grid size-6 place-items-center rounded-full border bg-background text-primary">{step.kind === "rail" ? <Workflow className="size-3" /> : <FileCode2 className="size-3" />}</span><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-sm font-medium">{step.name}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{step.action_name ?? step.flow_name ?? step.kind}{step.action_version ? `@${step.action_version}` : ""}</p></div><span className="flex items-center gap-2 text-xs text-muted-foreground"><StateBadge state={step.outcome} /><Clock3 className="size-3" />{step.latency_ms} ms</span></div></li>)}</ol> : <EmptyState title={t(trace.evidence_status === "not_collected" ? "deploymentDetail.evidenceNotCollected" : "deploymentDetail.noStepsTitle")} description={t(trace.evidence_status === "not_collected" ? "deploymentDetail.evidenceNotCollectedDescription" : "deploymentDetail.noStepsDescription")} />}</section>
    </div>
  </EntitySheet>;
}

function RuntimeStat({ label, value, detail, danger = false, onClick, actionLabel }: { label: string; value: string; detail: string; danger?: boolean; onClick?: () => void; actionLabel?: string }) { return <div className={`relative border-b px-4 py-3 last:border-b-0 sm:[&:nth-child(odd)]:border-r xl:border-b-0 xl:border-r xl:last:border-r-0 ${onClick ? "group hover:bg-muted/25" : ""}`}><dt className="text-[11px] text-muted-foreground">{label}</dt><dd className={`mt-0.5 font-display text-xl font-semibold tabular-nums ${danger ? "text-red-700" : ""}`}>{value}</dd><p className={`mt-0.5 text-[11px] ${onClick ? "text-primary" : "text-muted-foreground"}`}>{detail}</p>{onClick ? <button type="button" className="absolute inset-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40" aria-label={actionLabel} onClick={onClick}><ArrowUpRight className="absolute right-3 top-3 size-3.5 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground" /></button> : null}</div>; }
function ContextFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="border-b p-4 last:border-b-0 sm:border-r sm:[&:nth-child(even)]:border-r-0 lg:border-b-0 lg:[&:nth-child(even)]:border-r lg:last:border-r-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className={`mt-1 break-all text-sm font-medium ${mono ? "font-mono text-xs" : ""}`}>{value}</dd></div>; }
function InlineFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className={`mt-1 break-all text-sm font-medium ${mono ? "font-mono text-xs" : ""}`}>{value}</dd></div>; }
function TrafficMode({ value, selected, title, description }: { value: string; selected: boolean; title: string; description: string }) { return <label className={`flex min-h-24 cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ${selected ? "border-primary bg-primary/[0.04]" : "bg-card hover:bg-muted/35"}`}><RadioGroupItem value={value} className="mt-0.5" /><span><span className="block text-sm font-medium">{title}</span><span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">{description}</span></span></label>; }
function SeverityBadge({ severity }: { severity: DeploymentTraceFinding["severity"] }) { const { t } = useTranslation(); const classes = { critical: "border-red-200 bg-red-50 text-red-700", high: "border-orange-200 bg-orange-50 text-orange-700", medium: "border-amber-200 bg-amber-50 text-amber-700", low: "border-slate-200 bg-slate-50 text-slate-700" }[severity]; return <Badge variant="outline" className={classes}>{t(`deploymentDetail.severity.${severity}`)}</Badge>; }
function findingTitle(finding: DeploymentTraceFinding | undefined, policies: Policy[]) { if (!finding) return "—"; const policy = policies.find((item) => item.id === finding.policy_id); const rule = policy?.rules.find((item) => item.id === finding.rule_id); return rule?.name ?? policy?.name ?? finding.rule_id ?? finding.risk.replaceAll("_", " "); }
