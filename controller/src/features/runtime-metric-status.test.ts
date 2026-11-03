import { describe, expect, it } from "vitest";
import { runtimeMetricStatus, type RuntimeStatusMetric } from "./runtime-metric-status";
describe("runtime display thresholds", () => {
  it.each([
    ["error_rate", 2.99, "normal"], ["error_rate", 3, "warning"], ["error_rate", 8, "warning"], ["error_rate", 8.01, "critical"],
    ["p95_latency", 299, "normal"], ["p95_latency", 300, "warning"], ["p95_latency", 800, "warning"], ["p95_latency", 801, "critical"],
    ["intervention_rate", 9.99, "normal"], ["intervention_rate", 10, "warning"], ["intervention_rate", 30, "warning"], ["intervention_rate", 30.01, "critical"],
  ] as const)("classifies %s = %s as %s", (metric, value, status) => expect(runtimeMetricStatus(metric, value)).toBe(status));
  it.each(["error_rate", "p95_latency", "intervention_rate"] as RuntimeStatusMetric[])("does not label missing %s as healthy", metric => {
    for (const missing of [null, undefined, NaN, Infinity, -1]) expect(runtimeMetricStatus(metric, missing)).toBe("unknown");
    expect(runtimeMetricStatus(metric, 0)).toBe("normal");
  });
});
