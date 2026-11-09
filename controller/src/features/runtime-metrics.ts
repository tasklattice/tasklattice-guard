export const runtimeMetricKeys = [
  "p50_latency", "p95_latency", "p99_latency", "request_rate",
  "intervention_rate", "block_rate", "transform_rate", "error_rate", "timeout_rate",
] as const;
export type RuntimeMetricKey = typeof runtimeMetricKeys[number];
