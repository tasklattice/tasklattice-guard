import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Building2, ChevronRight, ListFilter, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { ConfirmationSheet } from "@/components/confirmation-sheet";
import { EntitySheet } from "@/components/entity-sheet";
import { EmptyState, ErrorNotice, InfoNotice, PageHeader, StateBadge } from "@/components/product-shell";
import {
  countTrafficConditions,
  createTrafficScopeQuery,
  isTrafficScopeValid,
  toTrafficScopeExpression,
  TrafficScopeBuilder,
  type TrafficScopeQuery,
} from "@/components/traffic-scope";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MultiSelectCombobox, type MultiSelectOption } from "@/components/ui/multi-select-combobox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { queryKeys } from "@/features/query-keys";
import { useAuth } from "@/lib/auth";
import {
  createRouterBindings,
  getRouters,
  getGuardrails,
  getEndpoints,
  getTrafficScopeFields,
  reorderRouterRoutes,
  setRouterEnabled,
  type Router,
  type Guardrail,
  type Endpoint,
  type TrafficCondition,
  type TrafficScopeExpression,
  type TrafficScopeField,
} from "@/lib/api";

const EMPTY_ENDPOINTS: Endpoint[] = [];
const EMPTY_TRAFFIC_FIELDS: TrafficScopeField[] = [];
type PendingRouterChange =
  | { kind: "toggle"; id: string; name: string; enabled: boolean }
  | { kind: "reorder"; endpointId: string; endpointName: string; routerIds: string[] };

export function RoutersPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const auth = useAuth();
  const canManage = auth.user?.role === "admin";
  const routersQuery = useQuery({ queryKey: queryKeys.routers, queryFn: getRouters });
  const guardrailsQuery = useQuery({ queryKey: queryKeys.guardrails, queryFn: getGuardrails });
  const endpointsQuery = useQuery({ queryKey: queryKeys.endpoints, queryFn: getEndpoints });
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingChange, setPendingChange] = useState<PendingRouterChange | null>(null);
  const routers = routersQuery.data?.items ?? [];
  const guardrails = guardrailsQuery.data?.items ?? [];
  const endpoints = endpointsQuery.data?.items ?? [];
  const scopedRouters = routers.filter((item) => item.endpoint_id && !item.is_default);
  const legacyRouters = routers.filter((item) => !item.endpoint_id && !item.is_default);
  const defaultRouter = routers.find((item) => item.is_default);
  const defaultGuardrail = defaultRouter
    ? guardrails.find((item) => item.id === defaultRouter.guardrail_id)
    : undefined;
  const routeGroups = endpoints
    .map((endpoint) => ({
      endpoint,
      routes: scopedRouters
        .filter((item) => item.endpoint_id === endpoint.id)
        .sort((left, right) => left.route_order - right.route_order || left.id.localeCompare(right.id)),
    }))
    .filter((item) => item.routes.length);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.routers }),
      queryClient.invalidateQueries({ queryKey: queryKeys.guardrails }),
      queryClient.invalidateQueries({ queryKey: queryKeys.metrics }),
    ]);
  };
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => setRouterEnabled(id, enabled),
    onSuccess: async () => { setPendingChange(null); await refresh(); },
    onError: (error) => notifyError(error, t("routers.operationFailed")),
  });
  const reorder = useMutation({
    mutationFn: ({ endpointId, routerIds }: { endpointId: string; routerIds: string[] }) => reorderRouterRoutes(endpointId, routerIds),
    onSuccess: async () => { setPendingChange(null); await refresh(); },
    onError: (error) => notifyError(error, t("routers.operationFailed")),
  });

  return (
    <section className="py-6 sm:py-8">
      <PageHeader
        title={t("pages.routers.title")}
        description={t("pages.routers.description")}
        action={canManage ? <Button className="min-h-11 self-start" onClick={() => setCreateOpen(true)}><Plus />{t("pages.routers.add")}</Button> : undefined}
      />

      {routersQuery.error ? <div className="mt-5"><ErrorNotice error={routersQuery.error} /></div> : null}
      {endpointsQuery.error ? <div className="mt-5"><ErrorNotice error={endpointsQuery.error} /></div> : null}
      {routersQuery.isLoading || endpointsQuery.isLoading ? <Skeleton className="mt-5 h-52 rounded-lg" /> : null}

      {!routersQuery.isLoading && !endpointsQuery.isLoading ? (
        <>
          {routeGroups.length ? (
            <div className="mt-4 grid gap-4">
              {routeGroups.map(({ endpoint, routes }) => (
                <EndpointRouteTable
                  key={endpoint.id}
                  endpoint={endpoint}
                  routes={routes}
                  guardrails={guardrails}
                  reordering={reorder.isPending}
                  canManage={canManage}
                  onToggle={(id, enabled) => setPendingChange({ kind: "toggle", id, enabled, name: routes.find((item) => item.id === id)?.name ?? id })}
                  onReorder={(routerIds) => setPendingChange({ kind: "reorder", endpointId: endpoint.id, endpointName: endpoint.name, routerIds })}
                />
              ))}
            </div>
          ) : (
            <div className="mt-4">
              <EmptyState
                title={t("routers.emptyTitle")}
                description={t("routers.emptyDescription")}
                action={canManage ? <Button onClick={() => setCreateOpen(true)}><ShieldCheck />{t("routers.createFirst")}</Button> : undefined}
              />
            </div>
          )}

          {legacyRouters.length ? (
            <section className="mt-4 overflow-hidden rounded-lg border bg-card">
              <div className="border-b bg-muted/35 px-5 py-4">
                <p className="text-sm font-semibold">{t("routers.legacyRoutes")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("routers.legacyRoutesDescription")}</p>
              </div>
              <div className="divide-y">
                {legacyRouters.map((router) => (
                  <LegacyRouterRow
                    key={router.id}
                    router={router}
                    guardrail={guardrails.find((item) => item.id === router.guardrail_id)}
                    onToggle={(enabled) => setPendingChange({ kind: "toggle", id: router.id, enabled, name: router.name })}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {defaultRouter ? (
            <section className="mt-4 rounded-lg border border-dashed bg-muted/20 px-5 py-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 size-4 text-primary" />
                  <div>
                    <Link
                      to="/integration/routers/$routerId"
                      params={{ routerId: defaultRouter.id }}
                      className="inline-flex min-h-7 items-center gap-1.5 rounded-sm text-sm font-medium outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/30"
                    >
                      {defaultRouter.name}<ChevronRight className="size-3.5" />
                    </Link>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("routers.defaultDescription")} · {defaultGuardrail?.name ?? defaultRouter.guardrail_id} · {t("routers.version", { version: defaultRouter.guardrail_version })}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3"><StateBadge state="protected" /><span className="text-xs font-medium text-muted-foreground">{t("routers.baseline")}</span></div>
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      <CreateRouterSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        guardrails={guardrails}
        onCreated={async () => { setCreateOpen(false); await refresh(); }}
      />
      <ConfirmationSheet
        open={Boolean(pendingChange)}
        onOpenChange={(open) => { if (!open && !toggle.isPending && !reorder.isPending) { setPendingChange(null); toggle.reset(); reorder.reset(); } }}
        eyebrow={t("routers.confirmChangeEyebrow")}
        title={t(pendingChange?.kind === "reorder" ? "routers.confirmReorderTitle" : pendingChange?.enabled ? "routers.confirmEnableTitle" : "routers.confirmPauseTitle", {
          name: pendingChange?.kind === "toggle" ? pendingChange.name : pendingChange?.endpointName ?? "",
        })}
        description={t(pendingChange?.kind === "reorder" ? "routers.confirmReorderDescription" : "routers.confirmToggleDescription")}
        cancelLabel={t("common.cancel")}
        confirmLabel={t(pendingChange?.kind === "reorder" ? "routers.confirmReorderAction" : pendingChange?.enabled ? "routers.enable" : "routers.pause")}
        pendingLabel={t("common.saving")}
        pending={toggle.isPending || reorder.isPending}
        variant={pendingChange?.kind === "toggle" && !pendingChange.enabled ? "warning" : "default"}
        onConfirm={() => {
          if (pendingChange?.kind === "toggle") toggle.mutate({ id: pendingChange.id, enabled: pendingChange.enabled });
          if (pendingChange?.kind === "reorder") reorder.mutate({ endpointId: pendingChange.endpointId, routerIds: pendingChange.routerIds });
        }}
      >
        <div className="rounded-lg border bg-muted/35 px-4 py-3 text-sm leading-6 text-muted-foreground">
          {t(pendingChange?.kind === "reorder" ? "routers.confirmReorderImpact" : pendingChange?.enabled ? "routers.confirmEnableImpact" : "routers.confirmPauseImpact")}
        </div>
        {toggle.error || reorder.error ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{(toggle.error ?? reorder.error) instanceof Error ? (toggle.error ?? reorder.error)?.message : t("routers.operationFailed")}</p> : null}
      </ConfirmationSheet>
    </section>
  );
}

function EndpointRouteTable({
  endpoint,
  routes,
  guardrails,
  reordering,
  canManage,
  onToggle,
  onReorder,
}: {
  endpoint: Endpoint;
  routes: Router[];
  guardrails: Guardrail[];
  reordering: boolean;
  canManage: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onReorder: (routerIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const catchAllIndex = routes.findIndex((item) => !item.traffic_scope.conditions.length);
  const lastMovableIndex = catchAllIndex >= 0 ? catchAllIndex - 1 : routes.length - 1;
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= routes.length) return;
    const next = [...routes];
    [next[index], next[target]] = [next[target], next[index]];
    onReorder(next.map((item) => item.id));
  };
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <header className="flex flex-col gap-3 border-b bg-muted/35 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-background"><Building2 className="size-4 text-primary" /></span>
          <div className="min-w-0"><h2 className="truncate text-sm font-semibold">{endpoint.name}</h2><p className="mt-1 text-xs text-muted-foreground">{endpoint.protocol.toUpperCase()} · {t("routers.routeCount", { count: routes.length })}</p></div>
        </div>
        <StateBadge state={endpoint.enabled ? endpoint.setup_status : "disabled"} />
      </header>
      <div className="hidden grid-cols-[104px_minmax(160px,1fr)_minmax(220px,1.5fr)_minmax(150px,.8fr)_150px] border-b px-5 py-2.5 text-xs font-medium text-muted-foreground xl:grid">
        <span>{t("routers.order")}</span><span>{t("routers.router")}</span><span>{t("routers.trafficScope")}</span><span>{t("routers.guardrailVersion")}</span><span>{t("common.status")}</span>
      </div>
      <div className="divide-y">
        {routes.map((router, index) => {
          const guardrail = guardrails.find((item) => item.id === router.guardrail_id);
          const catchAll = !router.traffic_scope.conditions.length;
          return (
            <article key={router.id} className="grid gap-4 px-5 py-4 xl:grid-cols-[104px_minmax(160px,1fr)_minmax(220px,1.5fr)_minmax(150px,.8fr)_150px] xl:items-center">
              <div className="flex flex-col items-start gap-1">
                <span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                <div className="flex">
                  <Button type="button" variant="ghost" size="icon" className="size-11" aria-label={t("routers.moveUp", { name: router.name })} disabled={!canManage || reordering || catchAll || index === 0} onClick={() => move(index, -1)}><ArrowUp className="size-3.5" /></Button>
                  <Button type="button" variant="ghost" size="icon" className="size-11" aria-label={t("routers.moveDown", { name: router.name })} disabled={!canManage || reordering || catchAll || index >= lastMovableIndex} onClick={() => move(index, 1)}><ArrowDown className="size-3.5" /></Button>
                </div>
              </div>
              <div><Link to="/integration/routers/$routerId" params={{ routerId: router.id }} className="group inline-flex min-h-11 items-center gap-2 rounded-md outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/30"><ListFilter className="size-4 text-primary" /><strong className="text-sm font-medium">{router.name}</strong><ChevronRight className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" /></Link><p className="text-xs text-muted-foreground">{catchAll ? t("routers.catchAllRoute") : t("routers.conditionCount", { count: countTrafficConditions(router.traffic_scope) })}</p></div>
              <TrafficScopeBadges router={router} />
              <div><p className="text-xs font-medium">{guardrail?.name ?? router.guardrail_id}</p><p className="mt-1 text-xs text-muted-foreground">{t("routers.version", { version: router.guardrail_version })}</p></div>
              <div className="flex items-center justify-between gap-3 xl:justify-start"><StateBadge state={router.enabled ? "protected" : "paused"} /><Switch disabled={!canManage} className="after:-inset-y-3.5" aria-label={`${t(router.enabled ? "routers.pause" : "routers.enable")} ${router.name}`} checked={router.enabled} onCheckedChange={(enabled) => onToggle(router.id, enabled)} /></div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function LegacyRouterRow({ router, guardrail, onToggle }: { router: Router; guardrail?: Guardrail; onToggle: (enabled: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <article className="grid gap-4 p-5 lg:grid-cols-[minmax(210px,1.1fr)_minmax(320px,1.8fr)_minmax(155px,.8fr)_132px] lg:items-center">
              <div><Link to="/integration/routers/$routerId" params={{ routerId: router.id }} className="group inline-flex min-h-11 items-center gap-2 rounded-md outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/30"><ListFilter className="size-4 text-primary" /><strong className="text-sm font-medium">{router.name}</strong><ChevronRight className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" /></Link><p className="text-xs text-muted-foreground">{t("routers.conditionCount", { count: countTrafficConditions(router.traffic_scope) })}</p></div>
      <TrafficScopeBadges router={router} />
      <div><p className="text-xs font-medium">{guardrail?.name ?? router.guardrail_id}</p><p className="mt-1 text-xs text-muted-foreground">{t("routers.version", { version: router.guardrail_version })}</p></div>
      <div className="flex items-center justify-between gap-3 lg:justify-start"><StateBadge state={router.enabled ? "protected" : "paused"} /><Switch className="after:-inset-y-3.5" aria-label={`${t(router.enabled ? "routers.pause" : "routers.enable")} ${router.name}`} checked={router.enabled} onCheckedChange={onToggle} /></div>
    </article>
  );
}

export function TrafficScopeBadges({ router }: { router: Router }) {
  const { t } = useTranslation();
  if (!router.traffic_scope.conditions.length) {
    return <span className="text-xs font-medium text-primary">{t(router.is_default ? "routers.unmatchedTraffic" : "routers.allTraffic")}</span>;
  }
  return <FilterExpressionSummary expression={router.traffic_scope} />;
}

function FilterExpressionSummary({ expression }: { expression: TrafficScopeExpression }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {expression.conditions.map((item, index) => (
        <div key={isFilterGroup(item) ? `group-${index}` : `${item.field}:${item.key ?? ""}:${index}`} className="contents">
          {index ? <span className="text-[10px] font-semibold text-muted-foreground">{expression.combinator.toUpperCase()}</span> : null}
          {isFilterGroup(item) ? (
            <span className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/20 p-1"><FilterExpressionSummary expression={item} /></span>
          ) : (
            <span className="max-w-full rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs text-foreground"><span className="text-muted-foreground">{filterKeyLabel(t, item)} {operatorLabel(t, item.operator)} </span><span className="break-all">{item.value}</span></span>
          )}
        </div>
      ))}
    </div>
  );
}

export function CreateRouterSheet({
  open,
  onOpenChange,
  guardrails,
  onCreated,
  initialGuardrailId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  guardrails: Guardrail[];
  onCreated: () => void;
  initialGuardrailId?: string;
}) {
  const { t } = useTranslation();
  const fieldQuery = useQuery({ queryKey: queryKeys.trafficScopeFields, queryFn: getTrafficScopeFields, enabled: open });
  const endpointQuery = useQuery({ queryKey: queryKeys.endpoints, queryFn: getEndpoints, enabled: open });
  const definitions = fieldQuery.data?.items ?? EMPTY_TRAFFIC_FIELDS;
  const endpoints = endpointQuery.data?.items ?? EMPTY_ENDPOINTS;
  const ready = useMemo(() => guardrails.filter((item) => item.published_current && !item.system_managed && !item.is_default), [guardrails]);
  const [name, setName] = useState("");
  const [guardrailId, setGuardrailId] = useState("");
  const [endpointIds, setEndpointIds] = useState<string[]>([]);
  const [trafficMode, setTrafficMode] = useState<"all" | "filtered">("all");
  const [filterQuery, setFilterQuery] = useState<TrafficScopeQuery>({ combinator: "and", rules: [] });
  const selectedEndpoints = endpointIds.map((id) => endpoints.find((item) => item.id === id)).filter((item): item is Endpoint => Boolean(item));
  const selectedAdapterId = selectedEndpoints[0]?.adapter_id;
  const selectedProtocol = selectedEndpoints[0]?.protocol;
  const scopeDefinitions = useMemo(
    () => filterDefinitionsForProtocol(definitions, selectedProtocol),
    [definitions, selectedProtocol],
  );
  const endpointOptions: MultiSelectOption[] = endpoints.map((endpoint) => ({
    value: endpoint.id,
    label: endpoint.name,
    description: `${endpoint.protocol.toUpperCase()} · ${t(`endpoints.setupStatuses.${endpoint.setup_status}`)}`,
    meta: endpoint.adapter_id,
    keywords: [endpoint.protocol, endpoint.adapter_id, endpoint.id],
    disabled: Boolean(selectedAdapterId && endpoint.adapter_id !== selectedAdapterId),
  }));

  useEffect(() => {
    if (!open) return;
    setName("");
    setEndpointIds([]);
    setTrafficMode("all");
    setGuardrailId(ready.some((item) => item.id === initialGuardrailId) ? initialGuardrailId ?? "" : ready[0]?.id ?? "");
  }, [initialGuardrailId, open, ready]);

  useEffect(() => {
    setFilterQuery(createTrafficScopeQuery(scopeDefinitions));
  }, [scopeDefinitions]);

  const payloadFilter = trafficMode === "all"
    ? { combinator: "and" as const, conditions: [] }
    : toTrafficScopeExpression(filterQuery, scopeDefinitions);
  const filterValid = trafficMode === "all" || isTrafficScopeValid(filterQuery, scopeDefinitions);
  const selectedGuardrail = ready.find((item) => item.id === guardrailId);
  const mutation = useMutation({
    mutationFn: () => createRouterBindings({ name, guardrail_id: guardrailId, endpoint_ids: endpointIds, traffic_scope: payloadFilter, enabled: true }),
    onSuccess: (result) => { toast.success(t("routers.createdBindings", { count: result.count })); onCreated(); },
    onError: (error) => notifyError(error, t("routers.operationFailed")),
  });
  const canCreate = Boolean(name.trim() && guardrailId && endpointIds.length && filterValid && !mutation.isPending);

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={t("routers.sheetEyebrow")}
      title={t("routers.sheetTitle")}
      description={t("routers.sheetDescription")}
      width="xl"
      footer={<><Button className="min-h-11" variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button><Button className="min-h-11" disabled={!canCreate} onClick={() => mutation.mutate()}><ShieldCheck />{t(mutation.isPending ? "routers.creating" : "routers.createBindings", { count: endpointIds.length || 1 })}</Button></>}
    >
      {!ready.length ? (
        <EmptyState title={t("routers.noTestedTitle")} description={t("routers.noTestedDescription")} />
      ) : (
        <div className="grid gap-7">
          <FormSection number="1" title={t("routers.trafficSource")} description={t("routers.trafficSourceDescription")}>
            <Field label={t("routers.routerName")} hint={t("routers.routerNameHint")}><Input autoFocus className="min-h-11 rounded-lg bg-card" value={name} onChange={(event) => setName(event.target.value)} placeholder="Finance production traffic" /></Field>
            {endpointQuery.isLoading ? <Skeleton className="h-24 rounded-lg" /> : null}
            {endpointQuery.error ? <ErrorNotice error={endpointQuery.error} /> : null}
            {!endpointQuery.isLoading && !endpoints.length ? (
              <EmptyState title={t("routers.noEndpointsTitle")} description={t("routers.noEndpointsDescription")} action={<Button className="min-h-11" asChild variant="outline"><Link to="/integration/endpoint"><Plus />{t("routers.createEndpoint")}</Link></Button>} />
            ) : endpoints.length ? (
              <Field label={t("routers.gateways")} hint={t("routers.gatewaysHint")}>
                <MultiSelectCombobox
                  ariaLabel={t("routers.gateways")}
                  emptyMessage={t("routers.noMatchingEndpoints")}
                  noOptionsMessage={t("routers.noEndpointsTitle")}
                  onValueChange={setEndpointIds}
                  options={endpointOptions}
                  placeholder={t("routers.selectGateways")}
                  searchPlaceholder={t("routers.searchGateways")}
                  value={endpointIds}
                />
              </Field>
            ) : null}
          </FormSection>

          <FormSection number="2" title={t("routers.trafficWithinSource")} description={t("routers.trafficWithinSourceDescription")}>
            <RadioGroup value={trafficMode} onValueChange={(value) => setTrafficMode(value as "all" | "filtered")} className="grid gap-3 sm:grid-cols-2">
              <TrafficModeOption value="all" selected={trafficMode === "all"} title={t("routers.allTraffic")} description={t("routers.allTrafficDescription")} />
              <TrafficModeOption value="filtered" selected={trafficMode === "filtered"} title={t("routers.filteredTraffic")} description={t("routers.filteredTrafficDescription")} />
            </RadioGroup>
            {trafficMode === "filtered" ? (
              <>
                {fieldQuery.isLoading ? <Skeleton className="h-72 rounded-lg" /> : null}
                {fieldQuery.error ? <ErrorNotice error={fieldQuery.error} /> : null}
                {scopeDefinitions.length ? <TrafficScopeBuilder definitions={scopeDefinitions} query={filterQuery} onQueryChange={setFilterQuery} /> : null}
                <InfoNotice title={t("routers.scopeTrustTitle")}>{t("routers.scopeTrustDescription")}</InfoNotice>
              </>
            ) : (
              <InfoNotice title={t("routers.catchAllTitle")}>{t("routers.catchAllDescription")}</InfoNotice>
            )}
          </FormSection>

          <FormSection number="3" title={t("routers.applyGuardrail")} description={t("routers.applyGuardrailDescription")}>
            <Field label={t("routers.guardrail")}>
              <Select disabled={Boolean(initialGuardrailId)} value={guardrailId} onValueChange={setGuardrailId}><SelectTrigger className="min-h-11 rounded-lg bg-card"><SelectValue /></SelectTrigger><SelectContent className="rounded-lg">{ready.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select>
            </Field>
            {selectedGuardrail ? (
              <div className="grid gap-3 rounded-lg border bg-muted/25 p-4 sm:grid-cols-3">
                <GuardrailFact label={t("routers.selectedGuardrail")} value={selectedGuardrail.name} />
                <GuardrailFact label={t("guardrails.policies")} value={t("guardrails.policyCount", { count: selectedGuardrail.policy_bindings.length })} />
                <GuardrailFact label={t("guardrails.testEvidence")} value={t("guardrails.testCount", { count: selectedGuardrail.test_case_count })} />
              </div>
            ) : null}
            {selectedGuardrail && selectedEndpoints.length ? (
              <div className="rounded-lg border border-primary/20 bg-primary/[0.04] p-4">
                <p className="text-xs font-medium text-muted-foreground">{t("routers.effectiveRoute")}</p>
                <p className="mt-1.5 text-sm font-semibold">{t("routers.effectiveRouteSummary", { count: selectedEndpoints.length, traffic: t(trafficMode === "all" ? "routers.allTraffic" : "routers.filteredTraffic"), guardrail: selectedGuardrail.name })}</p>
              </div>
            ) : null}
          </FormSection>
        </div>
      )}
    </EntitySheet>
  );
}

function TrafficModeOption({ value, selected, title, description }: { value: string; selected: boolean; title: string; description: string }) {
  return (
    <label className={`flex min-h-24 cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ${selected ? "border-primary bg-primary/[0.04]" : "bg-card hover:bg-muted/35"}`}>
      <RadioGroupItem value={value} className="mt-0.5" />
      <span><span className="block text-sm font-medium">{title}</span><span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">{description}</span></span>
    </label>
  );
}

export function filterDefinitionsForProtocol(definitions: TrafficScopeField[], protocol?: Endpoint["protocol"]) {
  return definitions.filter((item) => {
    if (item.id === "endpoint.id" || item.id === "protocol") return false;
    if (!protocol) return false;
    if (protocol === "litellm") return item.group !== "a2a";
    if (protocol === "a2a") return item.group !== "litellm";
    return item.group !== "litellm" && item.group !== "a2a";
  });
}

function FormSection({ number, title, description, children }: { number: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4">
      <div className="flex items-start gap-3"><span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{number}</span><div><h3 className="text-base font-semibold">{title}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div></div>
      <div className="grid gap-4 pl-0 sm:pl-10">{children}</div>
    </section>
  );
}

function GuardrailFact({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-sm font-medium">{value}</p></div>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="grid gap-2 text-sm font-medium">{label}{children}{hint ? <span className="text-xs font-normal leading-5 text-muted-foreground">{hint}</span> : null}</label>;
}

function isFilterGroup(item: TrafficCondition | TrafficScopeExpression): item is TrafficScopeExpression {
  return "conditions" in item;
}

function filterKeyLabel(t: (key: string) => string, condition: TrafficCondition) {
  const translated = t(`routers.trafficScopeFields.${condition.field.replaceAll(".", "_")}`);
  return condition.key ? `${translated}:${condition.key}` : translated;
}

function operatorLabel(t: (key: string) => string, operator: TrafficCondition["operator"]) {
  return t(`routers.trafficScopeOperators.${operator}`);
}

function notifyError(error: unknown, fallback: string) { toast.error(error instanceof Error ? error.message : fallback); }
