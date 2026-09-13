import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { formatEventTimestamp } from "@/components/dashboard/event-time";
import type { DeleteConfirmation as RouterDeletionConfirmation } from "@/lib/api";
import { useTranslation } from "react-i18next";
import { ArrowUpRight } from "lucide-react";
import { ProtectedDeleteSheet } from "@/components/protected-delete-sheet";
import { EmptyState, ErrorNotice, StateBadge } from "@/components/product-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Router, RouterDeletionImpact, RouterRuntimeTrace, Policy, RouterTraceFinding } from "@/lib/api";
export function DeleteRouterSheet({ router, open, impact, loading, deleting, error, onOpenChange, onRetry, onConfirm }: {
  router: Router;
  open: boolean;
  impact?: RouterDeletionImpact;
  loading: boolean;
  deleting: boolean;
  error: Error | null;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  onConfirm: (confirmation: RouterDeletionConfirmation) => void;
}) {
  const { t, i18n } = useTranslation();
  const [reason, setReason] = useState("");
  const telemetryFresh = Boolean(impact?.telemetry_fresh);
  const requiresSecondConfirmation = Boolean(impact?.requires_second_confirmation);

  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  return <ProtectedDeleteSheet
    open={open}
    onOpenChange={onOpenChange}
    entityName={router.name}
    loading={loading}
    ready={telemetryFresh}
    deleting={deleting}
    error={impact && !telemetryFresh ? new Error(t("routerDetail.deleteTelemetryStale")) : error}
    requiresConfirmation={requiresSecondConfirmation}
    impactItems={impact ? [
      { label: t("routerDetail.recentIncomingRequests", { minutes: impact.window_minutes }), value: impact.incoming_request_count.toLocaleString(i18n.language) },
      { label: t("routerDetail.activeRouteAffected"), value: impact.active_router_count.toLocaleString(i18n.language) },
    ] : []}
    copy={{
      eyebrow: t("routerDetail.deleteEyebrow"),
      title: t("routerDetail.deleteDialogTitle"),
      description: t("routerDetail.deleteDialogDescription", { name: router.name }),
      protectedMessage: t("routerDetail.recentTrafficWarning"),
      clearMessage: t("routerDetail.noRecentTraffic"),
      retentionNote: t("routerDetail.deleteRetentionNote"),
      continueLabel: t("routerDetail.continueDelete"),
      deleteLabel: t("routerDetail.deleteConfirm"),
      deletingLabel: t("routerDetail.deleting"),
      confirmTitle: t("routerDetail.deleteRecentTrafficTitle"),
      confirmDescription: t("routerDetail.deleteRecentTrafficDescription", { count: impact?.incoming_request_count ?? 0, minutes: impact?.window_minutes ?? 30 }),
      confirmWarning: t("routerDetail.deleteStopsTraffic"),
      typeNameLabel: t("routerDetail.typeNameToConfirm", { name: router.name }),
      protectedDeleteLabel: t("routerDetail.deleteDespiteTraffic"),
      cancelLabel: t("common.cancel"),
      backLabel: t("common.back"),
      retryLabel: t("common.retry"),
      reasonLabel: t("routerDetail.deleteReason"),
      reasonPlaceholder: t("routerDetail.deleteReasonPlaceholder"),
    }}
    reason={reason}
    onReasonChange={setReason}
    onRetry={onRetry}
    onConfirm={(confirmRecentTraffic, confirmationName) => onConfirm({
      reason: reason.trim(),
      confirm_recent_traffic: confirmRecentTraffic,
      ...(confirmationName ? { confirmation_name: confirmationName } : {}),
    })}
  />;
}

export function RouterRuntimeEventTable({ traces, loading, error, policies, onInspect }: { traces: RouterRuntimeTrace[]; loading: boolean; error: unknown; policies: Policy[]; onInspect: (trace: RouterRuntimeTrace) => void }) {
  const { t, i18n } = useTranslation();
  return <Card className="gap-0 overflow-hidden py-0 shadow-none">
    <header className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
      <div><div className="flex items-center gap-2"><h3 className="text-sm font-semibold">{t("routerDetail.eventLog")}</h3><Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px]">{traces.length}</Badge></div><p className="mt-0.5 text-xs text-muted-foreground">{t("routerDetail.eventLogDescription")}</p></div>
      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="size-1.5 rounded-full bg-emerald-500" />{t("routerDetail.liveEvents")}</span>
    </header>
    {loading ? <div className="space-y-px bg-border">{Array.from({ length: 8 }).map((_, index) => <Skeleton key={index} className="h-11 w-full rounded-none" />)}</div> : error ? <div className="p-4"><ErrorNotice error={error} /></div> : traces.length ? <div className="max-h-[30rem] overflow-auto [scrollbar-gutter:stable]"><table className="w-full min-w-[52rem] table-fixed text-left text-xs" aria-label={t("routerDetail.eventLog")}><thead className="sticky top-0 z-10 border-b bg-muted/95 text-[11px] text-muted-foreground backdrop-blur-sm"><tr><th scope="col" className="h-8 w-44 px-3 font-medium">{t("routerDetail.time")}</th><th scope="col" className="h-8 w-20 px-3 font-medium">{t("routerDetail.phase")}</th><th scope="col" className="h-8 w-24 px-3 font-medium">{t("routerDetail.decision")}</th><th scope="col" className="h-8 px-3 font-medium">{t("routerDetail.finding")}</th><th scope="col" className="h-8 w-20 px-3 text-right font-medium">{t("routerDetail.latency")}</th><th scope="col" className="h-8 w-12 px-0"><span className="sr-only">{t("routerDetail.inspect")}</span></th></tr></thead><tbody className="divide-y">{traces.map((trace) => {
      const timestamp = formatEventTimestamp(trace.created_at, i18n.language);
      return <tr key={trace.id} className="h-11 transition-colors hover:bg-muted/35"><td className="px-3 font-mono text-[11px] tabular-nums whitespace-nowrap" title={new Date(trace.created_at).toLocaleString(i18n.language)}><span className="text-muted-foreground">{timestamp.date}</span> {timestamp.time}</td><td className="px-3 font-mono text-[10px] uppercase text-muted-foreground">{trace.phase}</td><td className="px-3"><StateBadge state={trace.outcome} /></td><td className="truncate px-3">{trace.severity ? <span className="inline-flex max-w-full items-center gap-2"><SeverityBadge severity={trace.severity} /><span className="truncate text-[11px]">{findingTitle(trace.findings[0], policies)}</span></span> : <span className="text-[11px] text-muted-foreground">{t(trace.evidence_status === "not_collected" ? "routerDetail.evidenceNotCollected" : "routerDetail.noFinding")}</span>}</td><td className="px-3 text-right font-mono text-[11px] tabular-nums">{trace.latency_ms} ms</td><td className="p-0 text-center"><Button type="button" size="icon" variant="ghost" className="size-11 rounded-none" aria-label={t("routerDetail.inspectTrace", { id: trace.id })} onClick={() => onInspect(trace)}><ArrowUpRight className="size-3.5" /></Button></td></tr>;
    })}</tbody></table></div> : <div className="p-4"><EmptyState title={t("routerDetail.noEventsTitle")} description={t("routerDetail.noEventsDescription")} /></div>}
  </Card>;
}

type FindingSeverityFilter = "all" | RouterTraceFinding["severity"];

function SeverityBadge({ severity }: { severity: RouterTraceFinding["severity"] }) { const { t } = useTranslation(); const classes = { critical: "border-red-200 bg-red-50 text-red-700", high: "border-orange-200 bg-orange-50 text-orange-700", medium: "border-amber-200 bg-amber-50 text-amber-700", low: "border-slate-200 bg-slate-50 text-slate-700" }[severity]; return <Badge variant="outline" className={classes}>{t(`routerDetail.severity.${severity}`)}</Badge>; }
function findingTitle(finding: RouterTraceFinding | undefined, policies: Policy[]) { if (!finding) return "—"; const policy = policies.find((item) => item.id === finding.policy_id); const rule = policy?.rules.find((item) => item.id === finding.rule_id); return rule?.name ?? policy?.name ?? finding.rule_id ?? finding.risk.replaceAll("_", " "); }
