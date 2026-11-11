import { projectParams } from "@/lib/project-paths";
import { Table as CarbonTable, TableHead as CarbonTableHead, TableBody as CarbonTableBody, TableRow as CarbonTableRow, TableHeader as CarbonTableHeader, TableCell as CarbonTableCell } from "@carbon/react";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { formatEventTimestamp } from "@/components/dashboard/event-time";
import { ErrorNotice, StateBadge } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { RuntimeEvent } from "@/lib/controller-api";

type GuardrailReference = { id: string; name: string };

export function RuntimeEventStream({ items, loading, guardrails, error, refreshing, onRetry }: {
  items: RuntimeEvent[];
  loading: boolean;
  guardrails: GuardrailReference[];
  error?: Error | null;
  refreshing?: boolean;
  onRetry?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const guardrailNames = new Map(guardrails.map((item) => [item.id, item.name]));

  return (
    <Card className="gap-0 overflow-hidden py-0 shadow-none">
      <header className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t("dashboard.recentEvents")}</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{t("dashboard.recentEventsDescription")}</p>
        </div>
        <Button size="sm" variant="ghost" className="h-8 shrink-0 px-2 text-xs" asChild>
          <Link params={projectParams()} to="/$projectId/logs">{t("dashboard.viewAllEvents")}<ArrowRight /></Link>
        </Button>
      </header>

      {error ? <div className="p-4">
        <ErrorNotice error={error} />
        {onRetry ? <Button variant="ghost" disabled={refreshing} onClick={onRetry}>{t("common.retry")}</Button> : null}
      </div> : null}

      {loading ? (
        <div className="space-y-px bg-border">
          {Array.from({ length: 7 }).map((_, index) => <Skeleton key={index} className="h-9 w-full rounded-none" />)}
        </div>
      ) : items.length ? (
        <div className="max-h-[22rem] overflow-auto [scrollbar-gutter:stable]">
          <CarbonTable className="w-full min-w-[48rem] table-fixed text-left text-xs" aria-label={t("dashboard.eventStreamAria")}>
            <CarbonTableHead className="sticky top-0 z-10 border-b bg-muted/95 text-[11px] text-muted-foreground backdrop-blur-sm">
              <CarbonTableRow>
                <CarbonTableHeader scope="col" className="h-8 w-40 px-3 font-medium">{t("dashboard.lastSeen")}</CarbonTableHeader>
                <CarbonTableHeader scope="col" className="h-8 w-24 px-3 font-medium">{t("dashboard.outcome")}</CarbonTableHeader>
                <CarbonTableHeader scope="col" className="h-8 w-36 px-3 font-medium">{t("dashboard.guardrail")}</CarbonTableHeader>
                <CarbonTableHeader scope="col" className="h-8 px-3 font-medium">{t("dashboard.message")}</CarbonTableHeader>
                <CarbonTableHeader scope="col" className="h-8 w-24 px-3 text-right font-medium">{t("dashboard.eventId")}</CarbonTableHeader>
              </CarbonTableRow>
            </CarbonTableHead>
            <CarbonTableBody className="divide-y">
              {items.map((item) => {
                const timestamp = formatEventTimestamp(item.occurredAt, i18n.language);
                const guardrailName = item.guardrailId ? guardrailNames.get(item.guardrailId) ?? item.guardrailId : t("dashboard.unassigned");
                const detail = t("dashboard.runtimeEventMessage", { runner: item.runnerId, direction: t(item.direction === "incoming" ? "logs.inbound" : "logs.outbound"), duration: item.durationMs });
                return (
                  <CarbonTableRow key={item.id} className="h-10 transition-colors hover:bg-muted/40">
                    <CarbonTableCell className="px-3 font-mono text-[11px] whitespace-nowrap tabular-nums" title={new Date(item.occurredAt).toLocaleString(i18n.language)}>
                      <span className="text-muted-foreground">{timestamp.date}</span> {timestamp.time}
                    </CarbonTableCell>
                    <CarbonTableCell className="px-3"><StateBadge state={item.decision} /></CarbonTableCell>
                    <CarbonTableCell className="truncate px-3 text-[11px] text-muted-foreground" title={guardrailName}>{guardrailName}</CarbonTableCell>
                    <CarbonTableCell className="truncate px-3 text-xs" title={detail}>{detail}</CarbonTableCell>
                    <CarbonTableCell className="px-3 text-right"><code className="text-[10px] text-muted-foreground" title={item.id}>#{shortEventId(item.id)}</code></CarbonTableCell>
                  </CarbonTableRow>
                );
              })}
            </CarbonTableBody>
          </CarbonTable>
        </div>
      ) : !error ? (
        <div className="flex min-h-36 flex-col items-center justify-center px-6 text-center">
          <ShieldCheck className="size-5 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">{t("dashboard.noEventsTitle")}</p>
          <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">{t("dashboard.noEventsDescription")}</p>
        </div>
      ) : null}
    </Card>
  );
}

export function shortEventId(id: string) {
  return id.slice(-8);
}
