import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Activity, ArrowRight, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getMetricInterval } from "@/features/dashboard";
import type { Metrics, MetricTrendPoint, MetricTrendSeries } from "@/lib/api";

export type RuntimeMetricKey =
  | "p50_latency"
  | "p95_latency"
  | "p99_latency"
  | "request_rate"
  | "intervention_rate"
  | "block_rate"
  | "transform_rate"
  | "error_rate"
  | "timeout_rate";

const colors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

export function RuntimeMetricChart({ metrics }: { metrics: Metrics }) {
  const { t, i18n } = useTranslation();
  const [metric, setMetric] = useState<RuntimeMetricKey>("p95_latency");
  const series = metrics.trend_series.none;
  const visibleSeries = series.slice(0, colors.length);
  const definition = t(`dashboard.metricDefinitions.${metric}`);
  const chart = useMemo(
    () => buildChartData(visibleSeries, metric),
    [visibleSeries, metric],
  );
  const unit = metricUnit(metric, metrics.interval, t);
  const locale = i18n.language;

  return (
    <Card size="sm" className="min-w-0 gap-0 py-0 shadow-none">
      <CardHeader className="flex min-h-16 flex-col items-stretch justify-between gap-3 border-b px-4 py-3 xl:flex-row xl:items-center">
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0">
            <CardTitle className="text-sm">{t("dashboard.runtimeMetric")}</CardTitle>
            <CardDescription className="mt-0.5 text-xs">{t("dashboard.runtimeMetricDescription")}</CardDescription>
          </div>
          <Tooltip><TooltipTrigger asChild><button type="button" className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" aria-label={t("dashboard.metricDefinition")}><Info className="size-3.5" /></button></TooltipTrigger><TooltipContent className="max-w-72">{definition}</TooltipContent></Tooltip>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <span className="hidden shrink-0 text-xs text-muted-foreground 2xl:block">{t("dashboard.autoResolution", { interval: getMetricInterval(metrics.window) })}</span>
          <label className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
            {t("dashboard.metric")}
            <Select value={metric} onValueChange={(value) => setMetric(value as RuntimeMetricKey)}>
              <SelectTrigger className="h-9 min-w-0 flex-1 bg-card sm:w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                {metricKeys.map((key) => <SelectItem key={key} value={key}>{t(`dashboard.metrics.${key}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        </div>
      </CardHeader>
      <CardContent className="px-2 pt-1 pb-2 sm:px-4">
        {!metrics.total_decisions ? <RuntimeMetricEmpty /> : (
          <div className="h-[220px] w-full" aria-label={t("dashboard.runtimeMetricChartLabel")}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chart.data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="3 4" />
                <XAxis
                  dataKey="timestamp"
                  axisLine={false}
                  tickLine={false}
                  minTickGap={30}
                  tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                  tickFormatter={(value) => formatTick(String(value), metrics.window, locale)}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  width={48}
                  tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                  tickFormatter={(value) => formatCompact(Number(value), locale)}
                />
                <RechartsTooltip
                  cursor={{ stroke: "var(--input)", strokeDasharray: "3 3" }}
                  contentStyle={{ borderColor: "var(--border)", borderRadius: "var(--radius-control)", background: "var(--card)", boxShadow: "var(--shadow-overlay)" }}
                  labelFormatter={(value) => new Date(String(value)).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  formatter={(value, name) => [`${formatMetricValue(Number(value), metric, locale)}${unit ? ` ${unit}` : ""}`, String(name)]}
                />
                {chart.lines.map((line, index) => (
                  <Line
                    key={line.key}
                    type="monotone"
                    dataKey={line.key}
                    name={displaySeriesName(line.name, t)}
                    stroke={colors[index]}
                    strokeWidth={index === 0 ? 2 : 1.65}
                    dot={false}
                    activeDot={{ r: 3.5, strokeWidth: 2, fill: "var(--card)" }}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RuntimeMetricEmpty() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center px-5 text-center">
      <span className="grid size-8 place-items-center rounded-md bg-muted text-muted-foreground"><Activity className="size-4" /></span>
      <h3 className="mt-3 text-sm font-semibold">{t("dashboard.noTrafficTitle")}</h3>
      <p className="mt-1.5 max-w-md text-sm leading-6 text-muted-foreground">{t("dashboard.noTrafficDescription")}</p>
      <Button className="mt-4" variant="outline" asChild><Link to="/integration/routers">{t("dashboard.manageDeployments")}<ArrowRight /></Link></Button>
    </div>
  );
}

function buildChartData(series: MetricTrendSeries[], metric: RuntimeMetricKey) {
  const lines = series.map((item, index) => ({ key: `series_${index}`, name: item.name }));
  const timestamps = series[0]?.points.map((point) => point.timestamp) ?? [];
  const data = timestamps.map((timestamp, pointIndex) => {
    const row: Record<string, string | number | null> = { timestamp };
    series.forEach((item, seriesIndex) => {
      const point = item.points[pointIndex];
      row[`series_${seriesIndex}`] = point ? metricValue(point, metric) : null;
    });
    return row;
  });
  return { data, lines };
}

function metricValue(point: MetricTrendPoint, metric: RuntimeMetricKey) {
  if (metric === "p50_latency") return point.p50_latency_ms;
  if (metric === "p95_latency") return point.p95_latency_ms;
  if (metric === "p99_latency") return point.p99_latency_ms;
  if (metric === "request_rate") return point.total;
  if (!point.total) return 0;
  if (metric === "intervention_rate") return (point.blocked + point.transformed) / point.total * 100;
  if (metric === "block_rate") return point.blocked / point.total * 100;
  if (metric === "transform_rate") return point.transformed / point.total * 100;
  if (metric === "error_rate") return point.errored / point.total * 100;
  return point.timed_out / point.total * 100;
}

function metricUnit(metric: RuntimeMetricKey, interval: Metrics["interval"], t: ReturnType<typeof useTranslation>["t"]) {
  if (metric.endsWith("latency")) return "ms";
  if (metric === "request_rate") return t("dashboard.perInterval", { interval });
  return "%";
}

function formatMetricValue(value: number, metric: RuntimeMetricKey, locale: string) {
  if (metric.endsWith("latency") || metric === "request_rate") return Math.round(value).toLocaleString(locale);
  return value.toLocaleString(locale, { maximumFractionDigits: 2 });
}

function formatCompact(value: number, locale: string) {
  return Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatTick(value: string, window: Metrics["window"], locale: string) {
  const date = new Date(value);
  return window === "1h" || window === "24h"
    ? date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

function displaySeriesName(name: string, t: ReturnType<typeof useTranslation>["t"]) {
  if (name === "All traffic") return t("dashboard.allTraffic");
  if (name === "Unassigned") return t("dashboard.unassigned");
  return name[0]?.toUpperCase() + name.slice(1);
}

const metricKeys: RuntimeMetricKey[] = [
  "p50_latency",
  "p95_latency",
  "p99_latency",
  "request_rate",
  "intervention_rate",
  "block_rate",
  "transform_rate",
  "error_rate",
  "timeout_rate",
];
