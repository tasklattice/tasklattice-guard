import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { init, use, type EChartsType } from "echarts/core";
import { LineChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { Focus, RotateCcw } from "lucide-react";
import { runtimeActivityRange, runtimeChartOption, formatRuntimeValue, type RuntimeChartPalette } from "@/features/runtime-echarts-options";
import type { RuntimeChartPoint } from "@/features/runtime-metric-chart-data";
import type { RuntimeMetricKey } from "@/features/runtime-metrics";
import type { Metrics } from "@/lib/api";

use([LineChart, DataZoomComponent, GridComponent, TooltipComponent, SVGRenderer]);

export default function RuntimeMetricPlot({ data, visible, window: metricWindow, locale }: { data: RuntimeChartPoint[]; visible: RuntimeMetricKey[]; window: Metrics["window"]; locale: string }) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const [palette, setPalette] = useState<RuntimeChartPalette | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [keyboardIndex, setKeyboardIndex] = useState<number | null>(null);
  const activity = useMemo(() => runtimeActivityRange(data), [data]);
  const name = (key: RuntimeMetricKey) => key === "request_rate" ? t("runtimeMetrics.qps") : t(`dashboard.metrics.${key}`);

  useEffect(() => {
    const element = root.current!;
    const instance = init(element, undefined, { renderer: "svg" });
    chart.current = instance;
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(element);
    // ECharts needs resolved colors rather than CSS variable references.
    const readPalette = () => {
      const styles = getComputedStyle(element);
      const get = (token: string) => styles.getPropertyValue(token).trim();
      setPalette({ foreground: get("--foreground"), muted: get("--muted-foreground"), surface: get("--card"), border: get("--border"), grid: get("--chart-grid"), qps: get("--chart-1"), latency: get("--chart-3"), error: get("--destructive"), font: styles.fontFamily });
    };
    readPalette();
    const theme = new MutationObserver(readPalette);
    // Observe the chart's theme ancestors, without observing ECharts' own DOM updates.
    let ancestor: HTMLElement | null = element.parentElement;
    while (ancestor) { theme.observe(ancestor, { attributes: true, attributeFilter: ["class", "data-theme", "style"] }); ancestor = ancestor.parentElement; }
    instance.on("datazoom", () => {
      const zoom = (instance.getOption().dataZoom as Array<{ start: number; end: number }>)[0];
      setZoomed(zoom.start > 0.01 || zoom.end < 99.99);
    });
    return () => { resize.disconnect(); theme.disconnect(); instance.dispose(); chart.current = null; };
  }, []);

  useEffect(() => {
    if (!palette || !chart.current) return;
    chart.current.setOption(runtimeChartOption(data, visible, metricWindow, locale, palette, {
      name: key => key === "request_rate" ? t("runtimeMetrics.qps") : t(`dashboard.metrics.${key}`), noSample: t("runtimeMetrics.noSample"),
    }), { replaceMerge: ["series", "yAxis"], lazyUpdate: true });
  }, [data, visible, metricWindow, locale, palette, t]);

  const inspected = keyboardIndex === null ? null : data[Math.min(keyboardIndex, data.length - 1)];
  return <>
    <div className="runtime-metric-plot-tools">
      <span className="text-xs text-muted-foreground">{t(zoomed ? "runtimeMetrics.zoomed" : "runtimeMetrics.fullWindow")}</span>
      <div className="flex items-center gap-3">
        <button type="button" disabled={!activity} onClick={() => chart.current?.dispatchAction({ type: "dataZoom", ...activity })}><Focus className="size-3.5" />{t("runtimeMetrics.focusActivity")}</button>
        <button type="button" disabled={!zoomed} onClick={() => chart.current?.dispatchAction({ type: "dataZoom", start: 0, end: 100 })}><RotateCcw className="size-3.5" />{t("runtimeMetrics.resetZoom")}</button>
      </div>
    </div>
    <div ref={root} className="runtime-metric-plot" role="img" tabIndex={0} aria-label={`${t("dashboard.runtimeMetricChartLabel")}. ${t("runtimeMetrics.keyboard")}`}
      onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)) return;
        event.preventDefault();
        if (event.key === "Escape") { chart.current?.dispatchAction({ type: "hideTip" }); setKeyboardIndex(null); return; }
        const index = event.key === "Home" ? 0 : event.key === "End" ? data.length - 1 : Math.max(0, Math.min(data.length - 1, (keyboardIndex ?? -1) + (event.key === "ArrowRight" ? 1 : -1)));
        setKeyboardIndex(index);
        chart.current?.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: index });
      }} />
    <span className="sr-only" aria-live="polite">{inspected ? `${new Date(inspected.timestamp).toLocaleString(locale)}. ${visible.map(key => `${name(key)}: ${formatRuntimeValue(inspected[key], key, locale, t("runtimeMetrics.noSample"))}`).join(". ")}` : ""}</span>
  </>;
}
