import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { runtimeMetricStatus, runtimeStatusThresholds, type RuntimeStatusMetric } from "@/features/runtime-metric-status";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import "./runtime-metrics.scss";

export function RuntimeMetricValue({ metric, value, children, showStatus = false }: {
  metric: RuntimeStatusMetric;
  value: number | null;
  children: ReactNode;
  showStatus?: boolean;
}) {
  const { t } = useTranslation();
  const status = runtimeMetricStatus(metric, value);
  const label = t(`runtimeMetrics.${metric === "intervention_rate" ? "intervention." : ""}${status}`);
  const thresholds = runtimeStatusThresholds[metric];
  const hint = `${t("runtimeMetrics.thresholds", thresholds)}${metric === "intervention_rate" ? ` ${t("runtimeMetrics.interventionHint")}` : ""}`;
  return <Tooltip>
    <TooltipTrigger asChild>
      <button type="button" className="runtime-metric-value" data-status={status}
        aria-label={`${children}: ${label}. ${hint}`}>
        <span className="runtime-metric-value__number"><span className="runtime-metric-value__dot" aria-hidden="true" />{children}</span>
        {showStatus ? <span className="runtime-metric-value__status">{label}</span> : null}
      </button>
    </TooltipTrigger>
    <TooltipContent>{hint}</TooltipContent>
  </Tooltip>;
}
