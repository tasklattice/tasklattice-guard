import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { Metrics } from "@/lib/api";

export type RuntimeHealthAlertMetrics = {
  system_status: Metrics["system_status"];
  system_reasons?: Metrics["system_reasons"];
  latency_slo: Pick<Metrics["latency_slo"], "p95_status">;
  fail_closed_count: number;
  degraded_endpoints: number;
};

export function RuntimeHealthAlert({ metrics }: { metrics: RuntimeHealthAlertMetrics }) {
  const { t } = useTranslation();
  const detailKey = runtimeHealthDetailKey(metrics);

  if (!detailKey) return null;

  return (
    <Alert className="border-amber-200 bg-amber-50/70 text-amber-950">
      <TriangleAlert />
      <AlertTitle>{t(detailKey === "dashboard.healthSystem" ? "dashboard.platformAttention" : "dashboard.degraded")}</AlertTitle>
      <AlertDescription className="text-amber-900/75">{detailKey === "dashboard.healthSystem" && metrics.system_reasons?.some(reason => reason !== "all_required_components_ready")
        ? metrics.system_reasons.filter(reason => reason !== "all_required_components_ready").map(reason => <p key={reason}>{t(`platformStatus.reason.${reason}`)}</p>)
        : t(detailKey, { count: metrics.degraded_endpoints })}</AlertDescription>
    </Alert>
  );
}

function runtimeHealthDetailKey(metrics: RuntimeHealthAlertMetrics) {
  if (metrics.fail_closed_count > 0) return "dashboard.healthFailClosed";
  if (metrics.latency_slo.p95_status === "breached") return "dashboard.healthLatency";
  if (metrics.degraded_endpoints > 0) return "dashboard.healthEndpoint";
  if (metrics.system_status === "degraded") return "dashboard.healthSystem";
  return null;
}
