import { Dropdown, DismissibleTag, Pagination, Search, Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from "@carbon/react";
import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Bot, Filter, RefreshCw, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AuditQuery } from "../../shared/audit-query";
import { EntitySheet } from "@/components/entity-sheet";
import { EmptyState, ErrorNotice, PageHeader } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { queryKeys } from "@/features/query-keys";
import { listAuditEvents, type AuditEvent } from "@/lib/controller-api";
import "./audit-log.scss";

export function AuditLogPage() {
  const { t, i18n } = useTranslation();
  const search = useSearch({ from: "/audit-log" });
  const navigate = useNavigate({ from: "/audit-log" });
  const initialBefore = useRef(new Date().toISOString());
  const query = { ...search, before: search.before ?? initialBefore.current };
  const [text, setText] = useState(search.q);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const filterId = useId();
  useEffect(() => { setText(search.q); }, [search.q]);
  useEffect(() => {
    if (!search.before) void navigate({ search: previous => ({ ...previous, before: initialBefore.current }), replace: true, resetScroll: false });
  }, [search.before, navigate]);
  const update = (patch: Partial<AuditQuery>) => void navigate({
    search: previous => ({ ...previous, before: query.before, page: 1, ...patch }), resetScroll: false,
  });
  const audit = useQuery({
    queryKey: [...queryKeys.auditEvents, query],
    queryFn: ({ signal }) => listAuditEvents(query, signal),
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (audit.data && audit.data.page !== search.page) void navigate({
      search: previous => ({ ...previous, page: audit.data.page }), replace: true, resetScroll: false,
    });
  }, [audit.data, search.page, navigate]);
  const events = audit.data?.items ?? [];
  const facets = audit.data?.facets;
  const windowLabel = (value: string) => value === "all" ? t("auditLog.allTime") : t(`dashboard.windows.${value}`);
  const actorLabel = (value: string) => t(value === "human" ? "auditLog.humanActors" : value === "system" ? "auditLog.systemActors" : "auditLog.allActors");
  const filters: { key: "q" | "actor" | "window" | "kind" | "resourceType"; label: string; reset: string }[] = [
    ...(search.q ? [{ key: "q" as const, label: `${t("auditLog.keyword")}: ${search.q}`, reset: "" }] : []),
    ...(search.window !== "7d" ? [{ key: "window" as const, label: windowLabel(search.window), reset: "7d" }] : []),
    ...(search.actor !== "all" ? [{ key: "actor" as const, label: actorLabel(search.actor), reset: "all" }] : []),
    ...(search.kind ? [{ key: "kind" as const, label: `${t("auditLog.eventType")}: ${formatKind(search.kind)}`, reset: "" }] : []),
    ...(search.resourceType ? [{ key: "resourceType" as const, label: `${t("auditLog.resourceType")}: ${search.resourceType}`, reset: "" }] : []),
  ];
  const extraCount = [search.actor !== "all", Boolean(search.kind), Boolean(search.resourceType)].filter(Boolean).length;
  const clear = () => { setText(""); update({ q: "", actor: "all", kind: "", resourceType: "", window: "7d" }); };
  return <section className="audit-page py-8">
    <PageHeader title={t("auditLog.title")} description={t("auditLog.description")} />
    <section className="audit-results" aria-label={t("auditLog.results")}>
      <div className="audit-toolbar">
        <form className="audit-search" aria-label={t("auditLog.search")} onSubmit={event => { event.preventDefault(); update({ q: text.trim() }); }}>
          <Search size="lg" labelText={t("auditLog.search")} placeholder={t("auditLog.search")} value={text}
            onChange={event => setText(event.target.value.slice(0, 300))} closeButtonLabelText={t("auditLog.clearSearch")}
            onClear={() => { setText(""); update({ q: "" }); }} />
          <Button type="submit" variant="secondary" size="lg">{t("auditLog.submitSearch")}</Button>
        </form>
        <div className="audit-time"><AuditFilter label={t("auditLog.windowFilter")} hideLabel value={search.window} items={["24h", "7d", "30d", "all"]} itemLabel={windowLabel} onChange={value => update({ window: value as AuditQuery["window"] })} /></div>
        <Button variant={filtersOpen ? "secondary" : "ghost"} size="lg" aria-expanded={filtersOpen} aria-controls={filterId} onClick={() => setFiltersOpen(!filtersOpen)}>
          <Filter aria-hidden="true" />{t("auditLog.filters")}{extraCount ? ` (${extraCount})` : ""}
        </Button>
        <Button variant="ghost" size="lg" disabled={audit.isFetching} onClick={() => update({ before: new Date().toISOString() })}>
          <RefreshCw aria-hidden="true" />{t("auditLog.refresh")}
        </Button>
      </div>
      {filtersOpen && <div id={filterId} className="audit-filter-panel" role="group" aria-label={t("auditLog.filters")}>
        <AuditFilter label={t("auditLog.actorFilter")} value={search.actor} items={["all", "human", "system"]} itemLabel={actorLabel} onChange={value => update({ actor: value as AuditQuery["actor"] })} />
        <AuditFilter label={t("auditLog.eventType")} value={search.kind} items={["", ...new Set([...(facets?.kinds ?? []), ...(search.kind ? [search.kind] : [])])]} itemLabel={value => value ? formatKind(value) : t("auditLog.allEventTypes")} onChange={value => update({ kind: value })} />
        <AuditFilter label={t("auditLog.resourceType")} value={search.resourceType} items={["", ...new Set([...(facets?.resourceTypes ?? []), ...(search.resourceType ? [search.resourceType] : [])])]} itemLabel={value => value || t("auditLog.allResourceTypes")} onChange={value => update({ resourceType: value })} />
      </div>}
      {filters.length > 0 && <div className="audit-applied" aria-label={t("auditLog.appliedFilters")}>
        {filters.map(filter => <DismissibleTag key={filter.key} type="cool-gray" text={filter.label} title={filter.label} dismissTooltipLabel={t("auditLog.removeFilter", { name: filter.label })} onClose={() => update({ [filter.key]: filter.reset })} />)}
        <Button variant="ghost" size="sm" onClick={clear}>{t("auditLog.clearFilters")}</Button>
      </div>}
      <div className="audit-summary">
        <span role="status">{audit.isFetching ? t("auditLog.loading") : audit.data ? t("auditLog.eventCount", { count: audit.data.total }) : "—"}</span>
        <span>{t("auditLog.snapshot", { time: formatDate(query.before, i18n.language) })}</span>
      </div>
      {audit.isPending ? <div className="p-4"><Skeleton className="h-72 w-full" /></div> : audit.error ? <div className="p-4"><ErrorNotice error={audit.error} /><Button variant="ghost" onClick={() => void audit.refetch()}>{t("common.retry")}</Button></div> : !events.length ? <div className="p-6"><EmptyState title={t("auditLog.noAuditTitle")} description={t("auditLog.noMatchingAuditDescription")} />{filters.length > 0 && <Button variant="ghost" onClick={clear}>{t("auditLog.clearFilters")}</Button>}</div> : (
        <div className="audit-table-scroll">
          <Table size="lg" className="audit-table" aria-label={t("auditLog.results")}>
            <TableHead><TableRow>
              <TableHeader className="audit-time-column">{t("auditLog.columns.time")}</TableHeader>
              <TableHeader>{t("auditLog.columns.event")}</TableHeader>
              <TableHeader>{t("auditLog.columns.resource")}</TableHeader>
              <TableHeader className="audit-actor-column">{t("auditLog.columns.actor")}</TableHeader>
            </TableRow></TableHead>
            <TableBody>{events.map(event => <TableRow key={event.id} className="audit-row" onClick={() => setSelected(event)}>
              <TableCell><time dateTime={event.occurredAt} className="audit-timestamp">{formatDate(event.occurredAt, i18n.language)}</time></TableCell>
              <TableCell><button type="button" className="audit-event-link" onClick={() => setSelected(event)}>{formatKind(event.kind)}</button><code className="audit-secondary">{event.kind}</code></TableCell>
              <TableCell><span>{typeof event.detail.name === "string" && event.detail.name ? event.detail.name : event.resourceType}</span><code className="audit-secondary" title={formatResource(event)}>{formatResource(event)}</code></TableCell>
              <TableCell><ActorBadge event={event} /></TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </div>
      )}
      {audit.data && !audit.error && <Pagination size="md" totalItems={audit.data.total} page={audit.data.page} pageSize={search.limit}
        pageSizes={[...new Set([25, 50, 100, search.limit])].sort((a, b) => a - b)} disabled={audit.isFetching}
        onChange={({ page, pageSize }) => update({ limit: pageSize, page: pageSize === search.limit ? page : 1 })}
        itemsPerPageText={t("auditLog.itemsPerPage")} backwardText={t("eventPagination.previous")} forwardText={t("eventPagination.next")}
        pageNumberText={t("auditLog.pageNumber")} pageSelectLabelText={() => t("auditLog.pageNumber")}
        itemRangeText={(min, max, total) => t("auditLog.itemRange", { min, max, total })}
        pageRangeText={(_current, total) => t("auditLog.pageRange", { total })} />}
    </section>
    <AuditEventSheet event={selected} open={Boolean(selected)} onOpenChange={open => { if (!open) setSelected(null); }} />
  </section>;
}

function AuditFilter({ label, hideLabel = false, value, items, itemLabel, onChange }: {
  label: string; hideLabel?: boolean; value: string; items: string[]; itemLabel: (value: string) => string; onChange: (value: string) => void;
}) {
  const id = useId();
  const { t } = useTranslation();
  const options = items.map(value => ({ value, label: itemLabel(value) }));
  return <Dropdown<{ value: string; label: string }> id={id} size={hideLabel ? "lg" : "md"} titleText={label} label={label} hideLabel={hideLabel} items={options} selectedItem={options.find(item => item.value === value)}
    itemToString={item => item?.label ?? ""} onChange={({ selectedItem }) => { if (selectedItem) onChange(selectedItem.value); }}
    translateWithId={key => t(key === "close.menu" ? "common.closeOptions" : "common.openOptions", { name: "" })} />;
}

function ActorBadge({ event }: { event: AuditEvent }) {
  const { t } = useTranslation();
  const system = event.actorId === null;
  const Icon = system ? Bot : UserRound;
  return <span className="audit-actor" title={event.actorId ?? undefined}><Icon aria-hidden="true" size={16} /><span>{system ? t("auditLog.systemActor") : shortIdentifier(event.actorId!)}</span></span>;
}

function AuditEventSheet({ event, open, onOpenChange }: { event: AuditEvent | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, i18n } = useTranslation();
  if (!event) return null;
  const detail = Object.entries(event.detail);
  return <EntitySheet open={open} onOpenChange={onOpenChange} eyebrow={t("auditLog.detailEyebrow")} title={formatKind(event.kind)} description={event.id} width="lg" footer={<Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>}>
    <div className="grid gap-5">
      <dl className="grid overflow-hidden rounded-lg border grid-cols-2"><Fact label={t("auditLog.columns.time")} value={formatDate(event.occurredAt, i18n.language)} /><Fact label={t("auditLog.columns.actor")} value={event.actorId ?? t("auditLog.systemActor")} /><Fact label={t("auditLog.columns.event")} value={event.kind} mono /><Fact label={t("auditLog.columns.resource")} value={formatResource(event)} mono /></dl>
      <section><div className="mb-3"><h3 className="text-sm font-semibold">{t("auditLog.changeDetail")}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("auditLog.changeDetailDescription")}</p></div>{detail.length ? <dl className="divide-y overflow-hidden rounded-lg border">{detail.map(([key, value]) => <div key={key} className="grid gap-4 px-4 py-3 grid-cols-[11rem_minmax(0,1fr)]"><dt className="font-mono text-xs text-muted-foreground">{key}</dt><dd className="whitespace-pre-wrap break-all text-sm leading-5">{formatDetailValue(value)}</dd></div>)}</dl> : <div className="rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground">{t("auditLog.noChangeDetail")}</div>}</section>
    </div>
  </EntitySheet>;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="border-b p-4 last:border-b-0 border-r [&:nth-child(even)]:border-r-0 [&:nth-last-child(-n+2)]:border-b-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className={`mt-1 break-all text-sm font-medium ${mono ? "font-mono text-xs" : ""}`}>{value}</dd></div>;
}

function formatDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
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
  return JSON.stringify(value, null, 2);
}
