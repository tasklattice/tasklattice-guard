import { describe, expect, it } from "vitest";
import { init, use, setPlatformAPI } from "echarts/core";
import { LineChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { runtimeActivityRange, runtimeChartOption, type RuntimeChartPalette } from "./runtime-echarts-options";
import { buildRuntimeChartData } from "./runtime-metric-chart-data";

use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, SVGRenderer]);
setPlatformAPI({ measureText: text => ({ width: String(text).length * 7 }) });
const data = buildRuntimeChartData({ window: "1h", interval: "1m", window_start: "2026-11-03T00:00:00Z", trend: [0, 60, 180, 0, 120, 0].map((total, index) => ({ timestamp: `2026-11-03T00:0${index}:00Z`, total, allowed: total, blocked: 0, transformed: 0, errored: index === 2 ? 18 : 0, timed_out: 0, p50_latency_ms: 100, p95_latency_ms: 300 + index * 200, p99_latency_ms: 2000 })) });
const palette: RuntimeChartPalette = { foreground: "#161616", muted: "#525252", surface: "#fff", border: "#ddd", grid: "#eee", qps: "#0f62fe", latency: "#007d79", error: "#da1e28", font: "sans-serif" };
const labels = { name: (key: string) => key, noSample: "No requests" };
const option = () => runtimeChartOption(data, ["request_rate", "error_rate", "p95_latency"], "1h", "en", palette, labels);

describe("ECharts runtime plot", () => {
  it("renders actual cubic curves and markers while keeping missing samples disconnected", () => {
    const chart = init(null, undefined, { renderer: "svg", ssr: true, width: 1000, height: 320 });
    try {
      chart.setOption(option());
      const svg = chart.renderToSVGString();
      const paths = Array.from(new DOMParser().parseFromString(svg, "image/svg+xml").querySelectorAll("path"));
      const qps = paths.find(path => path.getAttribute("stroke") === palette.qps && path.getAttribute("stroke-width") === "2.25");
      expect(qps?.getAttribute("d")).toContain("C");
      const latency = paths.find(path => path.getAttribute("stroke") === palette.latency && path.getAttribute("stroke-width") === "2.25");
      expect(latency?.getAttribute("d")?.match(/M/g)?.length).toBe(2);
      // The isolated last latency measurement still has a visible marker.
      expect(paths.filter(path => path.getAttribute("stroke") === palette.latency).length).toBeGreaterThan(2);
    } finally { chart.dispose(); }
  });

  it("preserves an operator's zoom through a telemetry refresh and supports resetting", () => {
    const chart = init(null, undefined, { renderer: "svg", ssr: true, width: 1000, height: 320 });
    try {
      chart.setOption(option());
      chart.dispatchAction({ type: "dataZoom", start: 20, end: 80 });
      chart.setOption(option(), { replaceMerge: ["series", "yAxis"] });
      expect((chart.getOption().dataZoom as Array<{ start: number; end: number }>)[0]).toMatchObject({ start: 20, end: 80 });
      chart.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
      expect((chart.getOption().dataZoom as Array<{ start: number; end: number }>)[0]).toMatchObject({ start: 0, end: 100 });
    } finally { chart.dispose(); }
  });

  it("focuses measured activity with context and has no fake range for an empty window", () => {
    const points = [data[0], data[0], data[1], data[2], data[0], data[0]].map((point, index) => ({ ...point, timestamp: index * 1000 }));
    expect(runtimeActivityRange(points)).toEqual({ startValue: 1000, endValue: 4000 });
    expect(runtimeActivityRange(points.map(point => ({ ...point, request_rate: 0 })))).toBeNull();
  });
});
