import { metricWindowMilliseconds, type Metrics } from "@/lib/api";
import { runtimeMetricKeys, type RuntimeMetricKey } from "./runtime-metrics";

const intervalSeconds: Record<Metrics["interval"], number> = { "1m": 60, "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400 };
export type RuntimeChartPoint = { timestamp: number } & Record<RuntimeMetricKey, number | null>;

export function buildRuntimeChartData(metrics: Pick<Metrics, "trend" | "interval" | "window" | "window_start">): RuntimeChartPoint[] {
  const duration = intervalSeconds[metrics.interval] * 1000;
  const windowStart = Date.parse(metrics.window_start);
  const windowEnd = windowStart + metricWindowMilliseconds(metrics.window);
  return metrics.trend.map(point => {
    const timestamp = Date.parse(point.timestamp);
    // Boundary buckets only include the observed portion of the selected window.
    const seconds = Math.max(0, Math.min(timestamp + duration, windowEnd) - Math.max(timestamp, windowStart)) / 1000;
    const rate = (count: number) => point.total ? count / point.total * 100 : null;
    return {
      timestamp,
      request_rate: seconds > 0 ? point.total / seconds : null,
      error_rate: rate(point.errored),
      intervention_rate: rate(point.blocked + point.transformed),
      block_rate: rate(point.blocked),
      transform_rate: rate(point.transformed),
      timeout_rate: rate(point.timed_out),
      p50_latency: point.total ? point.p50_latency_ms : null,
      p95_latency: point.total ? point.p95_latency_ms : null,
      p99_latency: point.total ? point.p99_latency_ms : null,
    };
  });
}

export const coreRuntimeMetrics: RuntimeMetricKey[] = ["request_rate", "error_rate", "p95_latency", "intervention_rate"];
export const additionalRuntimeMetrics = runtimeMetricKeys.filter(key => !coreRuntimeMetrics.includes(key));
export const defaultRuntimeMetrics: RuntimeMetricKey[] = ["request_rate", "error_rate", "p95_latency"];

export function runtimeMetricAxis(metric: RuntimeMetricKey) {
  return metric === "request_rate" ? "qps" : metric.endsWith("latency") ? "latency" : "rate";
}

export function runtimeSeriesStyle(metric: RuntimeMetricKey) {
  const axis = runtimeMetricAxis(metric);
  return {
    color: axis === "qps" ? "var(--chart-1)" : axis === "latency" ? "var(--chart-3)" : metric === "error_rate" || metric === "timeout_rate" ? "var(--destructive)" : "var(--muted-foreground)",
    dash: ({ error_rate: "6 3", intervention_rate: "2 3", p50_latency: "2 3", p99_latency: "8 3", block_rate: "8 3", transform_rate: "4 2 1 2", timeout_rate: "2 3" } as Partial<Record<RuntimeMetricKey, string>>)[metric],
  };
}
