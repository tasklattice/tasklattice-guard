export type RuntimeStatusMetric = "error_rate" | "p95_latency" | "intervention_rate";
export type RuntimeMetricStatus = "normal" | "warning" | "critical" | "unknown";

// Display thresholds, independent of the configured runtime SLO / health status.
export const runtimeStatusThresholds = {
  error_rate: { warning: 3, critical: 8, unit: "%" },
  p95_latency: { warning: 300, critical: 800, unit: "ms" },
  intervention_rate: { warning: 10, critical: 30, unit: "%" },
} as const;

export function runtimeMetricStatus(metric: RuntimeStatusMetric, value: number | null | undefined): RuntimeMetricStatus {
  if (value == null || !Number.isFinite(value) || value < 0) return "unknown";
  const thresholds = runtimeStatusThresholds[metric];
  if (value > thresholds.critical) return "critical";
  if (value >= thresholds.warning) return "warning";
  return "normal";
}
