import { projectParams } from "@/lib/project-paths";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Skeleton } from "./ui/skeleton";
import type { RequestRatePoint } from "@/lib/observability-api";

export function GuardrailRequestRate({ guardrailId, name, points, loading, error }: {
  guardrailId: string; name: string; points?: RequestRatePoint[]; loading?: boolean; error?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const unavailable = error || (!loading && !points?.length);
  const total = points?.reduce((sum, point) => sum + point.total, 0) ?? 0;
  const maximum = Math.max(1, ...(points?.map(point => point.total) ?? []));
  const start = Date.parse(points?.[0]?.timestamp ?? "");
  const duration = Date.parse(points?.at(-1)?.timestamp ?? "") - start || 1;
  const line = points?.map(point => `${2 + (Date.parse(point.timestamp) - start) / duration * 156},${34 - point.total / maximum * 30}`).join(" ");

  return <Link to="/$projectId/guardrails/$guardrailId" params={{ ...projectParams(), guardrailId }}
    search={{ tab: "runtime", window: "1h", metric: "request_rate" }} hash="runtime-metrics"
    className="guardrail-request-rate" onClick={event => event.stopPropagation()}
    aria-label={t("guardrails.requestRateOpen", { name })} title={t("guardrails.requestRateHint")}>
    {loading ? <><Skeleton className="h-9 w-full" /><span className="guardrail-request-rate-caption">{t("common.loading")}</span></>
      : unavailable ? <span className="guardrail-request-rate-unavailable">{t("guardrails.requestRateUnavailable")}</span>
        : <>
          <svg viewBox="0 0 160 38" aria-hidden="true" focusable="false">
            <line x1="2" y1="34" x2="158" y2="34" stroke="var(--chart-grid)" />
            <polyline points={line} fill="none" stroke="var(--chart-1)" strokeWidth="1.75" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
          <span className="guardrail-request-rate-caption">{t("guardrails.requestRateTotal", { total: total.toLocaleString(i18n.language) })}</span>
        </>}
  </Link>;
}
