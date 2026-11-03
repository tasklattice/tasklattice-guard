import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { runtimeStatusThresholds } from "@/features/runtime-metric-status";
import { runtimeInvestigation, runtimeInvestigationLogs, type InvestigationMetric } from "@/features/runtime-investigation";
import type { Metrics } from "@/lib/api";
import { RuntimeMetricValue } from "./runtime-metric-value";

export function RuntimeInvestigationSheet({ metrics, metric, onClose }: { metrics: Metrics; metric: InvestigationMetric; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const investigation = runtimeInvestigation(metrics, metric);
  const logsSearch = runtimeInvestigationLogs(metrics, metric);
  const logsUrl = new URL("/logs", window.location.origin);
  for (const [key, value] of Object.entries(logsSearch)) if (value) logsUrl.searchParams.set(key, value);
  const label = t(`dashboard.metrics.${metric}`);
  const guidance = t(`dashboardInvestigation.${metric === "p95_latency" ? "latencyGuidance" : "errorGuidance"}`);
  const value = metric === "p95_latency" ? metrics.runtime_p95_ms : metrics.error_rate;
  const formattedValue = `${value.toLocaleString(i18n.language, { maximumFractionDigits: 2 })}${metric === "p95_latency" ? " ms" : "%"}`;
  const summary = [
    `TaskLattice Guard — ${t("dashboardInvestigation.summaryTitle")}`,
    t("dashboardInvestigation.summaryIntro"),
    `${t("dashboardInvestigation.scope")}: ${metrics.scope.guardrail_name ?? metrics.scope.guardrail_id ?? t("dashboard.allGuardrails")}${metrics.scope.guardrail_name && metrics.scope.guardrail_id ? ` (${metrics.scope.guardrail_id})` : ""}`,
    `${t("dashboardInvestigation.period")}: ${metrics.window_start} → ${logsSearch.until}`,
    `${t("dashboardInvestigation.observedAt")}: ${logsSearch.until}`,
    `${label}: ${formattedValue}`,
    `${t("dashboardInvestigation.reason")}: ${t(`dashboardInvestigation.${investigation?.reason === "slo" ? "sloExceeded" : "thresholdReason"}`)}`,
    t("runtimeMetrics.thresholds", runtimeStatusThresholds[metric]),
    `${t("dashboardInvestigation.configuredSlo")}: ${metrics.latency_slo.p95_budget_ms} ms`,
    `${t("dashboard.protectedTraffic")}: ${metrics.total_decisions.toLocaleString(i18n.language)}`,
    `${t("dashboard.p95Latency")}: ${metrics.runtime_p95_ms.toLocaleString(i18n.language)} ms`,
    `${t("dashboard.errorRate")}: ${metrics.error_rate.toLocaleString(i18n.language)}%`,
    t("dashboardInvestigation.outcomeCounts", { errors: metrics.errors, timeouts: metrics.timeout_count, failClosed: metrics.fail_closed_count }),
    guidance,
    `${t("dashboardInvestigation.logs")}: ${logsUrl.href}`,
  ].join("\n");

  return <Sheet open onOpenChange={open => { if (!open) onClose(); }}>
    <SheetContent className="runtime-investigation-sheet gap-0">
      <SheetHeader className="border-b p-6 pr-14">
        <SheetTitle>{t("dashboardInvestigation.contact")}</SheetTitle>
        <SheetDescription className="mt-2 leading-6">{t("dashboardInvestigation.sheetDescription")}</SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
        <section className="runtime-investigation-focus" data-status={investigation?.status}>
          <h3 className="text-sm font-medium">{label}</h3>
          <div className="mt-2 text-2xl font-semibold"><RuntimeMetricValue metric={metric} value={value} showStatus>{formattedValue}</RuntimeMetricValue></div>
          {investigation?.reason === "slo" ? <p className="mt-2 text-xs">{t("dashboardInvestigation.sloExceeded")}</p> : null}
          <p className="mt-3 text-sm leading-6">{guidance}</p>
        </section>
        <div>
          <label htmlFor="runtime-investigation-summary" className="mb-2 block text-sm font-medium">{t("dashboardInvestigation.summaryTitle")}</label>
          <Textarea id="runtime-investigation-summary" readOnly value={summary} rows={15} className="field:font-mono field:text-xs field:leading-6" />
        </div>
      </div>
      <SheetFooter className="runtime-investigation-footer border-t">
        <p role="status" className={`runtime-investigation-footer__status text-sm ${copyState === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
          {copyState === "copied" ? t("dashboardInvestigation.copied") : copyState === "failed" ? t("dashboardInvestigation.copyFailed") : null}
        </p>
        <div className="runtime-investigation-footer__actions">
          <Button variant="outline" asChild><Link to="/logs" search={logsSearch}>{t("dashboardInvestigation.viewLogs")}<ArrowUpRight /></Link></Button>
          <Button disabled={copyState === "copying"} onClick={async () => {
            setCopyState("copying");
            try { await navigator.clipboard.writeText(summary); setCopyState("copied"); }
            catch { setCopyState("failed"); }
          }}>{copyState === "copied" ? <Check /> : <Copy />}{t(`dashboardInvestigation.${copyState === "copying" ? "copying" : "copy"}`)}</Button>
        </div>
      </SheetFooter>
    </SheetContent>
  </Sheet>;
}
