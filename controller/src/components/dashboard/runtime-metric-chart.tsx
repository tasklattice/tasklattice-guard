import { projectParams } from "@/lib/project-paths";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Activity, ArrowRight, Check, Info } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { additionalRuntimeMetrics, buildRuntimeChartData, coreRuntimeMetrics, defaultRuntimeMetrics, runtimeSeriesStyle } from "@/features/runtime-metric-chart-data";
import type { RuntimeMetricKey } from "@/features/runtime-metrics";
import type { Metrics } from "@/lib/api";
import "./runtime-metrics.scss";

const RuntimeMetricPlot = lazy(() => import("./runtime-metric-plot"));

export function RuntimeMetricChart({ metrics, metric: selectedMetric, onMetricChange }: { metrics: Metrics; metric?: RuntimeMetricKey; onMetricChange?: (metric: RuntimeMetricKey) => void }) {
  const { t, i18n } = useTranslation();
  const [visible, setVisible] = useState<RuntimeMetricKey[]>(() => [...new Set([...defaultRuntimeMetrics, ...(selectedMetric ? [selectedMetric] : [])])]);
  // Preserve metric deep links while keeping the core correlation visible on entry.
  useEffect(() => {
    if (selectedMetric) setVisible(current => current.includes(selectedMetric) ? current : [...current, selectedMetric]);
  }, [selectedMetric]);
  const data = useMemo(() => buildRuntimeChartData(metrics), [metrics]);
  const name = (key: RuntimeMetricKey) => key === "request_rate" ? t("runtimeMetrics.qps") : t(`dashboard.metrics.${key}`);
  function toggle(key: RuntimeMetricKey) {
    const active = visible.includes(key);
    if (active && visible.length === 1) return;
    setVisible(current => active ? current.filter(item => item !== key) : [...current, key]);
    if (!active) onMetricChange?.(key);
  }
  const legend = (keys: RuntimeMetricKey[]) => keys.map(key => <button key={key} type="button" className="runtime-metric-toggle"
    aria-pressed={visible.includes(key)} disabled={visible.length === 1 && visible.includes(key)} onClick={() => toggle(key)}>
    <Check className="size-3" aria-hidden="true" style={{ visibility: visible.includes(key) ? "visible" : "hidden" }} />
    <SeriesSwatch metric={key} /><span>{name(key)}</span>
  </button>);

  return <Card size="sm" className="min-w-0 gap-0 py-0 shadow-none">
    <CardHeader className="flex flex-row items-center justify-between gap-4 border-b px-4 py-3">
      <div className="flex min-w-0 items-center gap-1">
        <div className="min-w-0">
          <CardTitle className="text-sm">{t("runtimeMetrics.title")}</CardTitle>
          <CardDescription className="mt-0.5 text-xs">{t("runtimeMetrics.description")}</CardDescription>
        </div>
        <Tooltip><TooltipTrigger asChild><button type="button" className="grid size-8 shrink-0 place-items-center text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" aria-label={t("dashboard.metricDefinition")}><Info className="size-3.5" /></button></TooltipTrigger><TooltipContent>{t("runtimeMetrics.definition")}</TooltipContent></Tooltip>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">{t("dashboard.autoResolution", { interval: metrics.interval })}</span>
    </CardHeader>
    <CardContent className="px-4 pt-2 pb-3">
      <div className="runtime-metric-legend" role="group" aria-label={t("runtimeMetrics.series")}>{legend(coreRuntimeMetrics)}</div>
      <details className="runtime-metric-more" open={additionalRuntimeMetrics.some(key => visible.includes(key)) || undefined}>
        <summary>{t("runtimeMetrics.more")}</summary>
        <div className="runtime-metric-legend">{legend(additionalRuntimeMetrics)}</div>
      </details>
      {!metrics.total_decisions ? <RuntimeMetricEmpty /> : <>
        <Suspense fallback={<div className="runtime-metric-plot-loading" role="status">{t("runtimeMetrics.loading")}</div>}>
          <RuntimeMetricPlot key={`${metrics.scope?.guardrail_id ?? "all"}:${metrics.window}`} data={data} visible={visible} window={metrics.window} locale={i18n.language} />
        </Suspense>
        <p className="mt-1 text-xs text-muted-foreground">{t("runtimeMetrics.axes")}</p>
      </>}
    </CardContent>
  </Card>;
}

function SeriesSwatch({ metric }: { metric: RuntimeMetricKey }) {
  const { color, dash } = runtimeSeriesStyle(metric);
  return <svg className="runtime-metric-swatch" viewBox="0 0 24 8" aria-hidden="true"><line x1="0" y1="4" x2="24" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dash} /></svg>;
}

function RuntimeMetricEmpty() {
  const { t } = useTranslation();
  return <div className="flex min-h-[220px] flex-col items-center justify-center px-5 text-center">
    <Activity className="size-5 text-muted-foreground" />
    <h3 className="mt-3 text-sm font-semibold">{t("dashboard.noTrafficTitle")}</h3>
    <p className="mt-1.5 max-w-md text-sm leading-6 text-muted-foreground">{t("dashboard.noTrafficDescription")}</p>
    <Button className="mt-4" variant="outline" asChild><Link params={projectParams()} to="/$projectId/integration/routers">{t("dashboard.manageRouters")}<ArrowRight /></Link></Button>
  </div>;
}
