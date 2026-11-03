import { describe, expect, it } from "vitest";
import type { MetricTrendPoint } from "@/lib/api";
import { buildRuntimeChartData } from "./runtime-metric-chart-data";
const point = (timestamp: string, total = 120): MetricTrendPoint => ({ timestamp, total, allowed: 102, blocked: 10, transformed: 2, errored: 6, timed_out: 3, p50_latency_ms: 120, p95_latency_ms: 450, p99_latency_ms: 950 });
describe("runtime correlation data", () => {
  it("uses each timestamp's observed bucket duration for QPS", () => {
    const data = buildRuntimeChartData({ window: "1h", interval: "1m", window_start: "2026-11-03T00:00:30Z", trend: [point("2026-11-03T00:00:00Z"), point("2026-11-03T00:01:00Z"), point("2026-11-03T01:00:00Z")] });
    expect(data.map(row => row.request_rate)).toEqual([4, 2, 4]);
    expect(data[1]).toMatchObject({ timestamp: Date.parse("2026-11-03T00:01:00Z"), error_rate: 5, intervention_rate: 10, timeout_rate: 2.5, p95_latency: 450 });
  });
  it.each([["1m", 60], ["15m", 900], ["1h", 3600], ["6h", 21600], ["1d", 86400]] as const)("converts %s buckets to requests per second", (interval, seconds) => {
    const data = buildRuntimeChartData({ window: "30d", interval, window_start: "2026-10-04T00:00:00Z", trend: [point("2026-11-02T00:00:00Z", seconds * 2)] });
    expect(data[0].request_rate).toBe(2);
  });
  it("distinguishes no traffic from zero errors and avoids division by zero", () => {
    const data = buildRuntimeChartData({ window: "1h", interval: "1m", window_start: "2026-11-03T00:00:00Z", trend: [point("2026-11-03T00:00:00Z", 0), { ...point("2026-11-03T00:01:00Z"), errored: 0 }, point("2026-11-03T01:00:00Z", 0)] });
    expect(data[0]).toMatchObject({ request_rate: 0, error_rate: null, intervention_rate: null, p95_latency: null });
    expect(data[1].error_rate).toBe(0);
    expect(data[2].request_rate).toBeNull();
  });
});
