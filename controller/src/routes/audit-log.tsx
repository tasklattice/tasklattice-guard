import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, Clock3, Search, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";

import { EntitySheet } from "@/components/entity-sheet";
import { EmptyState, ErrorNotice, PageHeader } from "@/components/product-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { queryKeys } from "@/features/query-keys";
import { listAuditEvents, type AuditEvent } from "@/lib/controller-api";

type ActorFilter = "all" | "human" | "system";
type AuditWindow = "24h" | "7d" | "30d" | "all";

export function AuditLogPage() {
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useState("");
  const [actor, setActor] = useState<ActorFilter>("all");
  const [window, setWindow] = useState<AuditWindow>("7d");
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const audit = useQuery({ queryKey: queryKeys.auditEvents, queryFn: () => listAuditEvents(500), refetchInterval: 30_000 });
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const since = window === "all" ? null : Date.now() - auditWindowMilliseconds(window);
    return (audit.data?.items ?? [])
      .filter((event) => since === null || Date.parse(event.occurredAt) >= since)
      .filter((event) => actor === "all" || (actor === "system" ? event.actorId === null : event.actorId !== null))
      .filter((event) => !term || [event.kind, event.actorId ?? "system", event.resourceType, event.resourceId, JSON.stringify(event.detail)].some((value) => value.toLowerCase().includes(term)))
      .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));
  }, [actor, audit.data, search, window]);

  return (
    <section className="py-6 sm:py-8">
      <PageHeader title={t("auditLog.title")} description={t("auditLog.description")} />

      <Card className="mt-6 gap-0 overflow-hidden p-0 shadow-none">
        <div className="grid gap-3 border-b bg-muted/20 p-4 sm:grid-cols-2 xl:grid-cols-[minmax(16rem,1fr)_12rem_12rem_auto] xl:items-center">
          <label className="relative sm:col-span-2 xl:col-span-1">
            <span className="sr-only">{t("auditLog.search")}</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} className="min-h-11 bg-card pl-9" placeholder={t("auditLog.search")} />
          </label>
          <Select value={actor} onValueChange={(value) => setActor(value as ActorFilter)}>
            <SelectTrigger className="min-h-11 bg-card" aria-label={t("auditLog.actorFilter")}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t("auditLog.allActors")}</SelectItem><SelectItem value="human">{t("auditLog.humanActors")}</SelectItem><SelectItem value="system">{t("auditLog.systemActors")}</SelectItem></SelectContent>
          </Select>
          <Select value={window} onValueChange={(value) => setWindow(value as AuditWindow)}>
            <SelectTrigger className="min-h-11 bg-card" aria-label={t("auditLog.windowFilter")}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="24h">{t("dashboard.windows.24h")}</SelectItem><SelectItem value="7d">{t("dashboard.windows.7d")}</SelectItem><SelectItem value="30d">{t("dashboard.windows.30d")}</SelectItem><SelectItem value="all">{t("auditLog.allTime")}</SelectItem></SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground sm:col-span-2 xl:col-span-1 xl:text-right">{t("auditLog.eventCount", { count: filtered.length })}</p>
        </div>

        {audit.isLoading ? <Skeleton className="m-4 h-72 rounded-lg" /> : audit.error ? <div className="p-4"><ErrorNotice error={audit.error} /></div> : !filtered.length ? <div className="p-4"><EmptyState title={t("auditLog.noAuditTitle")} description={t(audit.data?.items.length ? "auditLog.noMatchingAuditDescription" : "auditLog.noAuditDescription")} /></div> : (
          <>
            <div className="divide-y xl:hidden">{filtered.map((event) => <button key={event.id} type="button" onClick={() => setSelected(event)} className="block w-full p-4 text-left outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><strong className="block truncate text-sm font-medium">{formatKind(event.kind)}</strong><time className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground"><Clock3 className="size-3" />{formatDate(event.occurredAt, i18n.language)}</time></div><ActorBadge event={event} /></div><p className="mt-3 truncate text-xs text-muted-foreground">{formatResource(event)}</p></button>)}</div>
            <div className="hidden overflow-x-auto xl:block"><table className="w-full min-w-[56rem] table-fixed text-left text-xs"><thead className="border-b bg-muted/40 text-muted-foreground"><tr><th className="h-10 w-44 px-4 font-medium">{t("auditLog.columns.time")}</th><th className="h-10 w-64 px-4 font-medium">{t("auditLog.columns.event")}</th><th className="h-10 px-4 font-medium">{t("auditLog.columns.resource")}</th><th className="h-10 w-48 px-4 font-medium">{t("auditLog.columns.actor")}</th></tr></thead><tbody className="divide-y">{filtered.map((event) => <tr key={event.id} tabIndex={0} role="button" onClick={() => setSelected(event)} onKeyDown={(keyboardEvent) => { if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") setSelected(event); }} className="h-14 cursor-pointer outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30"><td className="px-4 font-mono text-[11px] text-muted-foreground">{formatDate(event.occurredAt, i18n.language)}</td><td className="px-4"><strong className="block truncate text-xs font-medium">{formatKind(event.kind)}</strong><span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">{event.kind}</span></td><td className="px-4"><span className="block truncate capitalize">{event.resourceType}</span><span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">{event.resourceId}</span></td><td className="px-4"><ActorBadge event={event} /></td></tr>)}</tbody></table></div>
          </>
        )}
      </Card>

      <AuditEventSheet event={selected} open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }} />
    </section>
  );
}

function ActorBadge({ event }: { event: AuditEvent }) {
  const { t } = useTranslation();
  const system = event.actorId === null;
  const Icon = system ? Bot : UserRound;
  return <Badge variant="outline" className="max-w-full font-normal" title={event.actorId ?? undefined}><Icon className="size-3" /><span className="truncate">{system ? t("auditLog.systemActor") : shortIdentifier(event.actorId!)}</span></Badge>;
}

function AuditEventSheet({ event, open, onOpenChange }: { event: AuditEvent | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, i18n } = useTranslation();
  if (!event) return null;
  const detail = Object.entries(event.detail);
  return <EntitySheet open={open} onOpenChange={onOpenChange} eyebrow={t("auditLog.detailEyebrow")} title={formatKind(event.kind)} description={event.id} width="lg" footer={<Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>}>
    <div className="grid gap-5">
      <dl className="grid overflow-hidden rounded-lg border sm:grid-cols-2"><Fact label={t("auditLog.columns.time")} value={formatDate(event.occurredAt, i18n.language)} /><Fact label={t("auditLog.columns.actor")} value={event.actorId ?? t("auditLog.systemActor")} /><Fact label={t("auditLog.columns.event")} value={event.kind} mono /><Fact label={t("auditLog.columns.resource")} value={formatResource(event)} mono /></dl>
      <section><div className="mb-3"><h3 className="text-sm font-semibold">{t("auditLog.changeDetail")}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("auditLog.changeDetailDescription")}</p></div>{detail.length ? <dl className="divide-y overflow-hidden rounded-lg border">{detail.map(([key, value]) => <div key={key} className="grid gap-1 px-4 py-3 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4"><dt className="font-mono text-[11px] text-muted-foreground">{key}</dt><dd className="break-all text-xs leading-5">{formatDetailValue(value)}</dd></div>)}</dl> : <div className="rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground">{t("auditLog.noChangeDetail")}</div>}</section>
    </div>
  </EntitySheet>;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="border-b p-4 last:border-b-0 sm:border-r sm:[&:nth-child(even)]:border-r-0 sm:[&:nth-last-child(-n+2)]:border-b-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className={`mt-1 break-all text-sm font-medium ${mono ? "font-mono text-xs" : ""}`}>{value}</dd></div>;
}

function auditWindowMilliseconds(window: Exclude<AuditWindow, "all">): number {
  return { "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 }[window];
}

function formatDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatKind(value: string) {
  return value.split(".").map((part) => {
    const readable = part.replaceAll("_", " ");
    return `${readable.charAt(0).toUpperCase()}${readable.slice(1)}`;
  }).join(" · ");
}

function formatResource(event: AuditEvent) {
  return `${event.resourceType} · ${event.resourceId}`;
}

function shortIdentifier(value: string) {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value;
}

function formatDetailValue(value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
