import { projectParams } from "@/lib/project-paths";
import { useState, type ComponentType } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Circle,
  CircleAlert,
  Clock3,
  Info,
  Settings2,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { RuntimeMetricValue } from "@/components/dashboard/runtime-metric-value";
import { RuntimeInvestigationSheet } from "@/components/dashboard/runtime-investigation-sheet";
import { RuntimeMetricChart } from "@/components/dashboard/runtime-metric-chart";
import { RuntimeHealthAlert } from "@/components/dashboard/runtime-health-alert";
import { RuntimeEventStream } from "@/components/dashboard/runtime-event-stream";
import { ErrorNotice, InfoNotice, PageHeader } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { runtimeMetricStatus, type RuntimeStatusMetric } from "@/features/runtime-metric-status";
import { runtimeInvestigation, runtimeInvestigationLogs, type InvestigationMetric } from "@/features/runtime-investigation";
import "./dashboard.scss";
import { useGuardrailsDashboard } from "@/features/dashboard";
import { cn } from "@/lib/utils";
import type { MetricWindow, Metrics } from "@/lib/api";

export function DashboardPage() {
  const { t } = useTranslation();
  const [investigation, setInvestigation] = useState<{ metric: InvestigationMetric; metrics: Metrics } | null>(null);
  const [guardrailId, setGuardrailId] = useState("all");
  const [window, setWindow] = useState<MetricWindow>("7d");
  const filters = {
    guardrailId: guardrailId === "all" ? undefined : guardrailId,
    window,
  };
  const dashboard = useGuardrailsDashboard(filters);
  const guardrails = dashboard.guardrails.data?.items ?? [];
  const openInvestigation = (metric: InvestigationMetric) => {
    if (dashboard.metrics.data) setInvestigation({ metric, metrics: dashboard.metrics.data });
  };

  return (
    <section className="py-6 sm:py-8">
      <PageHeader
        title={t("dashboard.title")}
        description={t("dashboard.description")}
        action={
          <DashboardFilters
            guardrailId={guardrailId}
            window={window}
            guardrails={guardrails}
            onGuardrailChange={setGuardrailId}
            onWindowChange={setWindow}
          />
        }
      />

      {dashboard.error ? (
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1"><ErrorNotice error={dashboard.error} /></div>
          <Button variant="outline" onClick={() => void Promise.all([dashboard.metrics.refetch(), dashboard.events.refetch(), dashboard.guardrails.refetch()])}>{t("common.retry")}</Button>
        </div>
      ) : null}

      {dashboard.metrics.isLoading ? <DashboardSkeleton /> : null}
      {dashboard.metrics.data ? (
        <div className="mt-5 space-y-4">
          {dashboard.metrics.data.data_availability?.runtime_events === "truncated" || dashboard.metrics.data.data_availability?.execution_evidence === "partial" || dashboard.metrics.data.data_availability?.execution_evidence === "not_collected" ? <InfoNotice title={t("dashboard.metricsPartialTitle")}>{t("dashboard.metricsPartialDescription", { returned: dashboard.metrics.data.data_availability.returned_events, total: dashboard.metrics.data.data_availability.matching_events })}</InfoNotice> : null}
          <RuntimeHealthAlert metrics={dashboard.metrics.data} />

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <OverviewMetricCard
              label={t("dashboard.protectedTraffic")}
              value={formatCompactCount(dashboard.metrics.data.total_decisions)}
              exactValue={dashboard.metrics.data.total_decisions.toLocaleString()}
              delta={dashboard.metrics.data.comparison.request_delta_pct}
              deltaKind="percent"
              semantic="neutral"
              definition={t("dashboard.metricDefinitions.protectedTraffic")}
            />
            <OverviewMetricCard
              metric="intervention_rate"
              numericValue={dashboard.metrics.data.total_decisions ? dashboard.metrics.data.intervention_rate : null}
              label={t("dashboard.interventionRate")}
              value={dashboard.metrics.data.total_decisions ? formatPercent(dashboard.metrics.data.intervention_rate) : "—"}
              delta={dashboard.metrics.data.comparison.intervention_rate_delta_pp}
              deltaKind="points"
              semantic="neutral"
              definition={t("dashboard.metricDefinitions.interventionRate")}
            />
            <OverviewMetricCard
              metric="p95_latency"
              numericValue={dashboard.metrics.data.total_decisions ? dashboard.metrics.data.runtime_p95_ms : null}
              investigation={runtimeInvestigation(dashboard.metrics.data, "p95_latency")}
              onInvestigate={() => openInvestigation("p95_latency")}
              label={t("dashboard.p95Latency")}
              value={dashboard.metrics.data.total_decisions ? `${dashboard.metrics.data.runtime_p95_ms.toLocaleString()} ms` : "—"}
              delta={dashboard.metrics.data.comparison.runtime_p95_delta_ms}
              deltaKind="milliseconds"
              semantic="lower-is-better"
              definition={t("dashboard.metricDefinitions.p95Latency")}
            />
            <OverviewMetricCard
              metric="error_rate"
              numericValue={dashboard.metrics.data.total_decisions ? dashboard.metrics.data.error_rate : null}
              investigation={runtimeInvestigation(dashboard.metrics.data, "error_rate")}
              onInvestigate={() => openInvestigation("error_rate")}
              label={t("dashboard.errorRate")}
              value={dashboard.metrics.data.total_decisions ? formatPercent(dashboard.metrics.data.error_rate) : "—"}
              delta={dashboard.metrics.data.comparison.error_rate_delta_pp}
              deltaKind="points"
              semantic="lower-is-better"
              definition={t("dashboard.metricDefinitions.errorRate")}
              supporting={dashboard.metrics.data.total_decisions ? t("dashboard.errorBreakdown", { errors: dashboard.metrics.data.errors, timeouts: dashboard.metrics.data.timeout_count, failClosed: dashboard.metrics.data.fail_closed_count }) : undefined}
            />
          </div>

          <div className="dashboard-runtime-grid">
            <RuntimeMetricChart metrics={dashboard.metrics.data} />
            <AttentionPanel metrics={dashboard.metrics.data} onInvestigate={openInvestigation} />
          </div>

          <ProtectionOutcome metrics={dashboard.metrics.data} />
          <RuntimeEventStream
            items={dashboard.events.data?.items ?? []}
            loading={dashboard.events.isLoading}
            guardrails={guardrails}
          />
        </div>
      ) : null}
      {investigation ? <RuntimeInvestigationSheet metrics={investigation.metrics} metric={investigation.metric} onClose={() => setInvestigation(null)} /> : null}
    </section>
  );
}

function DashboardFilters({ guardrailId, window, guardrails, onGuardrailChange, onWindowChange }: {
  guardrailId: string;
  window: MetricWindow;
  guardrails: Array<{ id: string; name: string }>;
  onGuardrailChange: (value: string) => void;
  onWindowChange: (value: MetricWindow) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(12rem,1fr)_10rem_auto] lg:w-auto lg:grid-cols-[13rem_10rem_auto]">
      <Select value={guardrailId} onValueChange={onGuardrailChange}>
        <SelectTrigger className="col-span-2 field:min-h-11 w-full field:bg-card sm:col-span-1" aria-label={t("dashboard.guardrailFilter")}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="all">{t("dashboard.allGuardrails")}</SelectItem>{guardrails.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={window} onValueChange={(value) => onWindowChange(value as MetricWindow)}>
        <SelectTrigger className="field:min-h-11 w-full field:bg-card" aria-label={t("dashboard.timeRangeFilter")}><Clock3 className="size-4 text-muted-foreground" /><SelectValue /></SelectTrigger>
        <SelectContent>
          {(["1h", "24h", "7d", "15d", "30d"] as MetricWindow[]).map((value) => <SelectItem key={value} value={value}>{t(`dashboard.windows.${value}`)}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button className="min-h-11 w-full sm:w-auto" asChild><Link params={projectParams()} to="/$projectId/integration/routers"><Settings2 />{t("dashboard.manage")}</Link></Button>
    </div>
  );
}

type DeltaSemantic = "higher-is-better" | "lower-is-better" | "neutral";
type DeltaKind = "percent" | "points" | "milliseconds";

function OverviewMetricCard({ label, value, exactValue, delta, deltaKind, semantic, definition, supporting, metric, numericValue = null, investigation, onInvestigate }: {
  label: string;
  value: string;
  exactValue?: string;
  delta: number | null;
  deltaKind: DeltaKind;
  semantic: DeltaSemantic;
  definition: string;
  supporting?: string;
  metric?: RuntimeStatusMetric;
  numericValue?: number | null;
  investigation?: ReturnType<typeof runtimeInvestigation>;
  onInvestigate?: () => void;
}) {
  const { t } = useTranslation();
  const positive = semantic === "higher-is-better" ? (delta ?? 0) > 0 : semantic === "lower-is-better" ? (delta ?? 0) < 0 : false;
  const negative = semantic === "higher-is-better" ? (delta ?? 0) < 0 : semantic === "lower-is-better" ? (delta ?? 0) > 0 : false;
  const Icon = delta === null || delta === 0 ? ArrowRight : delta > 0 ? ArrowUpRight : ArrowDownRight;
  const deltaText = delta === null
    ? t("dashboard.noPreviousData")
    : t(`dashboard.delta.${deltaKind}`, { value: Math.abs(delta).toLocaleString(undefined, { maximumFractionDigits: 2 }) });
  return (
    <Card className="dashboard-metric-card gap-3 py-4 shadow-none" role="region" aria-label={label} data-attention={investigation?.status}>
      <CardHeader className="flex grid-cols-none flex-row items-center justify-between gap-3">
        <CardDescription className="text-xs font-medium text-foreground/70">{label}</CardDescription>
        <Tooltip>
          <TooltipTrigger asChild><button type="button" className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" aria-label={t("dashboard.metricDefinition")}><Info className="size-3.5" /></button></TooltipTrigger>
          <TooltipContent className="max-w-72">{definition}</TooltipContent>
        </Tooltip>
      </CardHeader>
      <CardContent className="dashboard-metric-card__content">
        <div className="w-fit text-2xl font-semibold tabular-nums">
          {metric ? <RuntimeMetricValue metric={metric} value={numericValue} showStatus>{value}</RuntimeMetricValue>
            : <span title={exactValue}>{value}</span>}
        </div>
        {investigation ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{t(investigation.reason === "slo" ? "dashboardInvestigation.sloExceeded" : metric === "p95_latency" ? "dashboardInvestigation.latencyImpact" : "dashboardInvestigation.errorImpact")}</p> : null}
        <p className={cn("mt-2 flex min-h-5 items-center gap-1.5 text-xs", positive && "text-emerald-700", negative && "text-amber-700", !positive && !negative && "text-muted-foreground")}>
          <Icon className="size-3.5" />
          <span>{deltaText} {delta !== null ? t("dashboard.vsPrevious") : ""}</span>
        </p>
        {supporting ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{supporting}</p> : null}
        {metric === "intervention_rate" && ["warning", "critical"].includes(runtimeMetricStatus(metric, numericValue)) ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("dashboardInvestigation.reviewTraffic")}</p> : null}
        {investigation && onInvestigate ? <div className="dashboard-metric-card__actions">
          <button type="button" className="dashboard-contact-action" onClick={onInvestigate} aria-label={t("dashboardInvestigation.contactAbout", { metric: label })}>
            {t("dashboardInvestigation.contact")}<ArrowUpRight className="size-4" aria-hidden="true" />
          </button>
        </div> : null}
      </CardContent>
    </Card>
  );
}

function AttentionPanel({ metrics, onInvestigate }: { metrics: Metrics; onInvestigate: (metric: InvestigationMetric) => void }) {
  const { t } = useTranslation();
  if (!metrics.total_decisions) return <GettingStarted metrics={metrics} />;
  const investigations = (["p95_latency", "error_rate"] as const).flatMap(metric => {
    const issue = runtimeInvestigation(metrics, metric);
    return issue ? [{ metric, ...issue }] : [];
  }).sort((a, b) => Number(b.status === "critical") - Number(a.status === "critical"));
  const items = [
    metrics.degraded_endpoints ? { icon: CircleAlert, title: t("dashboard.attentionEndpoint"), detail: t("dashboard.attentionEndpointDetail", { count: metrics.degraded_endpoints }), to: "/$projectId/integration/endpoints" as const } : null,
    metrics.fail_closed_count ? { icon: ShieldCheck, title: t("dashboard.attentionFailClosed"), detail: t("dashboard.attentionFailClosedDetail", { count: metrics.fail_closed_count }), to: "/$projectId/logs" as const } : null,
    metrics.guardrails_needing_test ? { icon: CircleAlert, title: t("dashboard.attentionTesting"), detail: t("dashboard.attentionTestingDetail", { count: metrics.guardrails_needing_test }), to: "/$projectId/guardrails" as const } : null,
  ].filter(Boolean) as Array<{ icon: ComponentType<{ className?: string }>; title: string; detail: string; to: "/$projectId/logs" | "/$projectId/integration/endpoints" | "/$projectId/guardrails" }>;

  return <Card className="dashboard-attention gap-0 py-0 shadow-none">
    <CardHeader className="border-b py-3">
      <CardTitle>{t("dashboard.attention")}</CardTitle>
      <CardDescription className="text-xs leading-5">{t(investigations.length ? "dashboardInvestigation.attentionDescription" : "dashboard.attentionDescription")}</CardDescription>
    </CardHeader>
    <CardContent className="py-2">
      {investigations.map(issue => <button key={issue.metric} type="button" className="dashboard-attention-issue" data-status={issue.status} onClick={() => onInvestigate(issue.metric)}>
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t(issue.metric === "p95_latency" ? "dashboardInvestigation.latencyTitle" : "dashboardInvestigation.errorTitle")}</span>
          <span className="mt-1 block text-xs text-muted-foreground">{issue.metric === "p95_latency" ? `${metrics.runtime_p95_ms.toLocaleString()} ms` : formatPercent(metrics.error_rate)} · {t(issue.reason === "slo" ? "dashboardInvestigation.sloExceeded" : `runtimeMetrics.${issue.status}`)}</span>
          <span className="mt-2 flex items-center gap-1 text-xs font-medium text-primary">{t("dashboardInvestigation.contact")}<ArrowUpRight className="size-3.5" /></span>
        </span>
      </button>)}
      {items.map(item => <Link params={projectParams()} key={item.title} to={item.to} search={item.to === "/$projectId/logs" ? runtimeInvestigationLogs(metrics) : {}} className="dashboard-attention-link">
        <item.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1"><span className="block text-xs font-medium">{item.title}</span><span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{item.detail}</span></span>
        <ArrowRight className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
      </Link>)}
      {!investigations.length && !items.length ? <div className="flex flex-col items-center px-3 py-8 text-center">
        <CheckCircle2 className="size-5 text-[var(--success)]" />
        <p className="mt-3 text-sm font-semibold">{t("dashboardInvestigation.noAttention")}</p>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{t("dashboardInvestigation.noAttentionDescription")}</p>
      </div> : null}
    </CardContent>
  </Card>;
}

function GettingStarted({ metrics }: { metrics: Metrics }) {
  const { t } = useTranslation();
  const guardrailCreated = metrics.total_guardrails > 0;
  const guardrailTested = guardrailCreated && metrics.guardrails_needing_test < metrics.total_guardrails;
  const routerCreated = metrics.total_routers > 0;
  const steps = [
    [guardrailCreated, t("dashboard.guardrailCreated")],
    [guardrailTested, t("dashboard.guardrailTested")],
    [routerCreated, t("dashboard.routerCreated")],
    [false, t("dashboard.protectLiveTraffic")],
  ] as const;
  return (
    <Card className="shadow-none">
      <CardHeader><CardTitle>{t("dashboard.gettingStarted")}</CardTitle><CardDescription>{t("dashboard.gettingStartedDescription")}</CardDescription></CardHeader>
      <CardContent className="flex min-h-[310px] flex-col">
        <div className="space-y-1">{steps.map(([done, label]) => <div key={label} className="flex min-h-10 items-center gap-3 rounded-lg px-2 text-sm"><span className={cn("grid size-5 place-items-center rounded-full", done ? "bg-emerald-50 text-emerald-700" : "text-muted-foreground")}>
          {done ? <Check className="size-3.5" /> : <Circle className="size-3.5" />}
        </span>{label}</div>)}</div>
      <Button className="mt-auto w-full" variant="outline" asChild><Link params={projectParams()} to={guardrailCreated ? "/$projectId/integration/routers" : "/$projectId/guardrails"}>{guardrailCreated ? t("dashboard.createRouter") : t("dashboard.createGuardrail")}<ArrowRight /></Link></Button>
      </CardContent>
    </Card>
  );
}

function ProtectionOutcome({ metrics }: { metrics: Metrics }) {
  const { t } = useTranslation();
  const total = metrics.total_decisions;
  const outcomes = [
    { key: "allow", count: metrics.allowed, color: "var(--outcome-allow)" },
    { key: "transform", count: metrics.intervened, color: "var(--outcome-transform)" },
    { key: "block", count: metrics.blocked, color: "var(--outcome-block)" },
  ] as const;
  return (
    <Card className="shadow-none">
      <CardHeader><CardTitle>{t("dashboard.protectionOutcome")}</CardTitle><CardDescription>{t("dashboard.protectionOutcomeDescription")}</CardDescription></CardHeader>
      <CardContent>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={t("dashboard.outcomeAria", { allow: metrics.allowed, transform: metrics.intervened, block: metrics.blocked })}>
          {outcomes.map((item) => <span key={item.key} style={{ width: `${total ? item.count / total * 100 : 0}%`, background: item.color }} />)}
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {outcomes.map((item) => <div key={item.key} className="flex items-center gap-3">
            <span className="size-2 rounded-full" style={{ background: item.color }} />
            <span className="text-sm">{t(`dashboard.outcomes.${item.key}`)}</span>
            <span className="ml-auto font-mono text-sm tabular-nums">{total ? formatPercent(item.count / total * 100) : "—"}</span>
            <span className="w-14 text-right text-xs text-muted-foreground tabular-nums">{formatCompactCount(item.count)}</span>
          </div>)}
        </div>
        {metrics.errors ? <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">{t("dashboard.errorsSeparate", { count: metrics.errors, rate: formatPercent(metrics.error_rate) })}</p> : null}
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return <div className="mt-5 space-y-4"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-32 rounded-xl" />)}</div><div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]"><Skeleton className="h-[430px] rounded-xl" /><Skeleton className="h-[430px] rounded-xl" /></div><Skeleton className="h-44 rounded-xl" /><Skeleton className="h-72 rounded-xl" /></div>;
}

function formatCompactCount(value: number) {
  return Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: value >= 10_000 ? 2 : 0 }).format(value);
}

function formatPercent(value: number) {
  return `${value.toLocaleString(undefined, { minimumFractionDigits: value > 0 && value < 0.1 ? 2 : 1, maximumFractionDigits: 2 })}%`;
}
