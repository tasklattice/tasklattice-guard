import { metricWindowMilliseconds, type Metrics } from "@/lib/api";
import { runtimeMetricStatus } from "./runtime-metric-status";

export type InvestigationMetric = "p95_latency" | "error_rate";

export function runtimeInvestigation(metrics: Metrics, metric: InvestigationMetric) {
  const value = metric === "p95_latency" ? metrics.runtime_p95_ms : metrics.error_rate;
  const status = runtimeMetricStatus(metric, metrics.total_decisions ? value : null);
  if (status === "unknown") return null;
  if (status === "warning" || status === "critical") return { status, reason: "threshold" as const };
  // A stricter configured SLO still needs attention even below the display threshold.
  if (metric === "p95_latency" && metrics.latency_slo.p95_status === "breached") return { status: "warning" as const, reason: "slo" as const };
  return null;
}

export function runtimeInvestigationLogs(metrics: Metrics, metric?: InvestigationMetric) {
  return {
    guardrailId: metrics.scope.guardrail_id ?? undefined,
    since: metrics.window_start,
    until: new Date(Date.parse(metrics.window_start) + metricWindowMilliseconds(metrics.window)).toISOString(),
    outcome: metric === "error_rate" ? "error" as const : undefined,
  };
}
