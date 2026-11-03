import type { EChartsCoreOption } from "echarts/core";
import type { LineSeriesOption } from "echarts/charts";
import type { Metrics } from "@/lib/api";
import { runtimeMetricAxis, runtimeSeriesStyle, type RuntimeChartPoint } from "./runtime-metric-chart-data";
import type { RuntimeMetricKey } from "./runtime-metrics";

export type RuntimeChartPalette = { foreground: string; muted: string; surface: string; border: string; grid: string; qps: string; latency: string; error: string; font: string };
type ChartLabels = { name: (key: RuntimeMetricKey) => string; noSample: string };
const axisIndex = { qps: 0, rate: 1, latency: 2 };

export function runtimeActivityRange(data: RuntimeChartPoint[]) {
  const first = data.findIndex(point => (point.request_rate ?? 0) > 0);
  if (first < 0) return null;
  let last = data.length - 1;
  while (last > first && !(data[last].request_rate! > 0)) last--;
  return { startValue: data[Math.max(0, first - 1)].timestamp, endValue: data[Math.min(data.length - 1, last + 1)].timestamp };
}

export function formatRuntimeValue(value: number | null, metric: RuntimeMetricKey, locale: string, noSample: string) {
  if (value === null) return noSample;
  if (metric === "request_rate") return `${value.toLocaleString(locale, { maximumSignificantDigits: 3 })} QPS`;
  return metric.endsWith("latency") ? `${Math.round(value).toLocaleString(locale)} ms` : `${value.toLocaleString(locale, { maximumFractionDigits: 2 })}%`;
}

export function runtimeChartOption(data: RuntimeChartPoint[], visible: RuntimeMetricKey[], window: Metrics["window"], locale: string, palette: RuntimeChartPalette, labels: ChartLabels): EChartsCoreOption {
  const hasAxis = (axis: string) => visible.some(key => runtimeMetricAxis(key) === axis);
  const color = (key: RuntimeMetricKey) => runtimeMetricAxis(key) === "qps" ? palette.qps : runtimeMetricAxis(key) === "latency" ? palette.latency : key === "error_rate" || key === "timeout_rate" ? palette.error : palette.muted;
  const time = (timestamp: number, detail = false) => new Date(timestamp).toLocaleString(locale, {
    month: "short", day: "numeric", ...(detail || window === "1h" || window === "24h" ? { hour: "2-digit", minute: "2-digit" } as const : {}),
  });
  const tickTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const clock = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    return window === "1h" ? clock : `${date.toLocaleDateString(locale, { month: "short", day: "numeric" })}\n${clock}`;
  };
  const percentMax = Math.min(100, Math.max(10, Math.ceil(Math.max(0, ...data.flatMap(point => visible.filter(key => runtimeMetricAxis(key) === "rate").map(key => point[key] ?? 0))) / 10) * 10));
  const compact = (value: number) => Intl.NumberFormat(locale, { notation: "compact", maximumSignificantDigits: 3 }).format(value);
  const axis = { type: "value", min: 0, splitNumber: 4, axisLine: { show: false }, axisTick: { show: false }, nameTextStyle: { fontSize: 11, padding: [0, 0, 6, 0] }, axisLabel: { fontSize: 11, color: palette.muted, formatter: compact }, splitLine: { show: false } };
  const series: LineSeriesOption[] = visible.map(key => ({
    id: key, name: labels.name(key), type: "line", yAxisIndex: axisIndex[runtimeMetricAxis(key)],
    // X-monotone smoothing rounds joins without inventing overshoot between samples.
    smooth: 0.3, smoothMonotone: "x", connectNulls: false, clip: true,
    showSymbol: true, showAllSymbol: true, symbol: "circle",
    symbolSize: (_value, params) => {
      const index = params.dataIndex;
      const value = data[index]?.[key];
      if (value == null) return 0;
      // Keep the long, empty baseline quiet; real measurements and segment ends remain visible.
      if (key === "request_rate" && value === 0 && !data[index - 1]?.[key] && !data[index + 1]?.[key]) return 0;
      return 4;
    },
    itemStyle: { color: palette.surface, borderColor: color(key), borderWidth: 1.5 },
    lineStyle: { color: color(key), width: 2.25, type: runtimeSeriesStyle(key).dash?.split(" ").map(Number) ?? "solid" },
    emphasis: { focus: "series", scale: 1.6, lineStyle: { width: 3 } },
    data: data.map(point => [point.timestamp, point[key]]),
    z: key === "error_rate" ? 4 : 3,
  }));
  return {
    animation: false,
    textStyle: { fontFamily: palette.font, color: palette.foreground },
    grid: { top: 30, left: hasAxis("qps") ? 58 : 16, right: hasAxis("rate") && hasAxis("latency") ? 116 : hasAxis("rate") || hasAxis("latency") ? 62 : 16, bottom: 76 },
    xAxis: { type: "time", min: data[0]?.timestamp, max: data.at(-1)?.timestamp, boundaryGap: false, splitNumber: 6,
      axisLine: { lineStyle: { color: palette.border } }, axisTick: { show: false }, splitLine: { show: false },
      axisLabel: { color: palette.muted, fontSize: 11, lineHeight: 16, hideOverlap: true, formatter: tickTime } },
    yAxis: [
      { ...axis, show: hasAxis("qps"), name: "QPS", position: "left", axisLabel: { ...axis.axisLabel, color: palette.qps }, nameTextStyle: { ...axis.nameTextStyle, color: palette.qps }, splitLine: { show: true, lineStyle: { color: palette.grid, type: "dashed" } } },
      { ...axis, show: hasAxis("rate"), name: "%", position: "right", max: percentMax, interval: percentMax / 4, axisLabel: { ...axis.axisLabel, formatter: (value: number) => `${value}%` }, splitLine: { show: !hasAxis("qps"), lineStyle: { color: palette.grid, type: "dashed" } } },
      { ...axis, show: hasAxis("latency"), name: "ms", position: "right", offset: hasAxis("rate") ? 58 : 0, axisLabel: { ...axis.axisLabel, color: palette.latency }, nameTextStyle: { ...axis.nameTextStyle, color: palette.latency }, splitLine: { show: !hasAxis("qps") && !hasAxis("rate"), lineStyle: { color: palette.grid, type: "dashed" } } },
    ],
    tooltip: {
      trigger: "axis", confine: true, padding: 0, borderWidth: 0, backgroundColor: palette.surface,
      axisPointer: { type: "line", snap: true, lineStyle: { color: palette.muted, type: "dashed" } },
      formatter: (params: { dataIndex: number } | { dataIndex: number }[]) => {
        const point = data[(Array.isArray(params) ? params[0] : params)?.dataIndex];
        if (!point) return "";
        const container = document.createElement("div");
        container.className = "runtime-metric-tooltip";
        const date = document.createElement("time");
        date.textContent = time(point.timestamp, true);
        container.append(date);
        visible.forEach(key => {
          const row = document.createElement("div"); row.className = "runtime-metric-tooltip__row";
          const swatch = document.createElement("span"); swatch.className = "runtime-metric-tooltip__swatch";
          swatch.style.borderColor = color(key); swatch.style.borderTopStyle = runtimeSeriesStyle(key).dash ? "dashed" : "solid";
          const name = document.createElement("span"); name.textContent = labels.name(key);
          const value = document.createElement("strong"); value.textContent = formatRuntimeValue(point[key], key, locale, labels.noSample);
          row.append(swatch, name, value); container.append(row);
        });
        return container;
      },
    },
    dataZoom: [
      { id: "runtime-inside", type: "inside", xAxisIndex: 0, filterMode: "none", zoomOnMouseWheel: "ctrl", moveOnMouseWheel: false },
      { id: "runtime-slider", type: "slider", xAxisIndex: 0, filterMode: "none", bottom: 4, height: 24, left: 58, right: 116, borderColor: palette.border, backgroundColor: palette.surface,
        fillerColor: "rgba(15,98,254,0.07)", handleStyle: { color: palette.surface, borderColor: palette.qps }, moveHandleSize: 0,
        dataBackground: { lineStyle: { color: palette.muted, opacity: 0.4 }, areaStyle: { opacity: 0 } },
        selectedDataBackground: { lineStyle: { color: palette.qps }, areaStyle: { opacity: 0 } },
        textStyle: { color: palette.muted, fontSize: 11 }, labelFormatter: (value: number) => time(value, true), brushSelect: true,
      },
    ],
    series,
  };
}
