import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Building2, ChevronRight, ListFilter, Plus, Route, ShieldCheck } from "lucide-react";
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
  createDeploymentBindings,
  getDeployments,
  getGuardrails,
  getIntegrations,
  getTrafficScopeFields,
  reorderDeploymentRoutes,
  setDeploymentEnabled,
  type Deployment,
  type Guardrail,
  type Integration,
  type TrafficCondition,
  type TrafficScopeExpression,
  type TrafficScopeField,
} from "@/lib/api";

const EMPTY_INTEGRATIONS: Integration[] = [];
const EMPTY_TRAFFIC_FIELDS: TrafficScopeField[] = [];
type PendingDeploymentChange =
  | { kind: "toggle"; id: string; name: string; enabled: boolean }
  | { kind: "reorder"; integrationId: string; integrationName: string; deploymentIds: string[] };

export function DeploymentsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const auth = useAuth();
  const canManage = auth.user?.role === "admin";
  const deploymentsQuery = useQuery({ queryKey: queryKeys.deployments, queryFn: getDeployments });
  const guardrailsQuery = useQuery({ queryKey: queryKeys.guardrails, queryFn: getGuardrails });
  const integrationsQuery = useQuery({ queryKey: queryKeys.integrations, queryFn: getIntegrations });
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingChange, setPendingChange] = useState<PendingDeploymentChange | null>(null);
  const deployments = deploymentsQuery.data?.items ?? [];
  const guardrails = guardrailsQuery.data?.items ?? [];
  const integrations = integrationsQuery.data?.items ?? [];
  const scopedDeployments = deployments.filter((item) => item.integration_id && !item.is_default);
  const legacyDeployments = deployments.filter((item) => !item.integration_id && !item.is_default);
  const defaultDeployment = deployments.find((item) => item.is_default);
  const defaultGuardrail = defaultDeployment
    ? guardrails.find((item) => item.id === defaultDeployment.guardrail_id)
    : undefined;
  const routeGroups = integrations
    .map((integration) => ({
      integration,
      routes: scopedDeployments
        .filter((item) => item.integration_id === integration.id)
        .sort((left, right) => left.route_order - right.route_order || left.id.localeCompare(right.id)),
    }))
    .filter((item) => item.routes.length);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.deployments }),
      queryClient.invalidateQueries({ queryKey: queryKeys.guardrails }),
      queryClient.invalidateQueries({ queryKey: queryKeys.metrics }),
    ]);
  };
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => setDeploymentEnabled(id, enabled),
    onSuccess: async () => { setPendingChange(null); await refresh(); },
    onError: (error) => notifyError(error, t("deployments.operationFailed")),
  });
  const reorder = useMutation({
    mutationFn: ({ integrationId, deploymentIds }: { integrationId: string; deploymentIds: string[] }) => reorderDeploymentRoutes(integrationId, deploymentIds),
    onSuccess: async () => { setPendingChange(null); await refresh(); },
    onError: (error) => notifyError(error, t("deployments.operationFailed")),
  });

  return (
    <section className="py-6 sm:py-8">
      <PageHeader
        title={t("pages.deployments.title")}
        description={t("pages.deployments.description")}
        action={canManage ? <Button className="min-h-11 self-start" onClick={() => setCreateOpen(true)}><Plus />{t("pages.deployments.add")}</Button> : undefined}
      />

      {deploymentsQuery.error ? <div className="mt-5"><ErrorNotice error={deploymentsQuery.error} /></div> : null}
      {integrationsQuery.error ? <div className="mt-5"><ErrorNotice error={integrationsQuery.error} /></div> : null}
      {deploymentsQuery.isLoading || integrationsQuery.isLoading ? <Skeleton className="mt-5 h-52 rounded-lg" /> : null}

      {!deploymentsQuery.isLoading && !integrationsQuery.isLoading ? (
        <>
          <div className="mt-5 flex min-h-14 items-center gap-3 rounded-lg border bg-card px-4 py-3">
            <Route className="size-4 text-primary" />
            <div><p className="text-sm font-medium">{t("deployments.precedenceTitle")}</p><p className="mt-0.5 text-xs text-muted-foreground">{t("deployments.precedenceDescription")}</p></div>
          </div>

          {routeGroups.length ? (
            <div className="mt-4 grid gap-4">
              {routeGroups.map(({ integration, routes }) => (
                <IntegrationRouteTable
                  key={integration.id}
                  integration={integration}
                  routes={routes}
                  guardrails={guardrails}
                  reordering={reorder.isPending}
                  canManage={canManage}
                  onToggle={(id, enabled) => setPendingChange({ kind: "toggle", id, enabled, name: routes.find((item) => item.id === id)?.name ?? id })}
                  onReorder={(deploymentIds) => setPendingChange({ kind: "reorder", integrationId: integration.id, integrationName: integration.name, deploymentIds })}
                />
              ))}
            </div>
          ) : (
            <div className="mt-4">
              <EmptyState
                title={t("deployments.emptyTitle")}
                description={t("deployments.emptyDescription")}
                action={canManage ? <Button onClick={() => setCreateOpen(true)}><ShieldCheck />{t("deployments.createFirst")}</Button> : undefined}
              />
            </div>
          )}

          {legacyDeployments.length ? (
            <section className="mt-4 overflow-hidden rounded-lg border bg-card">
              <div className="border-b bg-muted/35 px-5 py-4">
                <p className="text-sm font-semibold">{t("deployments.legacyRoutes")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("deployments.legacyRoutesDescription")}</p>
              </div>
              <div className="divide-y">
                {legacyDeployments.map((deployment) => (
                  <LegacyDeploymentRow
                    key={deployment.id}
                    deployment={deployment}
                    guardrail={guardrails.find((item) => item.id === deployment.guardrail_id)}
                    onToggle={(enabled) => setPendingChange({ kind: "toggle", id: deployment.id, enabled, name: deployment.name })}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {defaultDeployment ? (
            <section className="mt-4 rounded-lg border border-dashed bg-muted/20 px-5 py-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 size-4 text-primary" />
                  <div>
                    <Link
                      to="/deployments/$deploymentId"
                      params={{ deploymentId: defaultDeployment.id }}
                      className="inline-flex min-h-7 items-center gap-1.5 rounded-sm text-sm font-medium outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/30"
                    >
                      {defaultDeployment.name}<ChevronRight className="size-3.5" />
                    </Link>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("deployments.defaultDescription")} · {defaultGuardrail?.name ?? defaultDeployment.guardrail_id} · {t("deployments.version", { version: defaultDeployment.guardrail_version })}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3"><StateBadge state="protected" /><span className="text-xs font-medium text-muted-foreground">{t("deployments.baseline")}</span></div>
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      <CreateDeploymentSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        guardrails={guardrails}
        onCreated={async () => { setCreateOpen(false); await refresh(); }}
      />
      <ConfirmationSheet
        open={Boolean(pendingChange)}
        onOpenChange={(open) => { if (!open && !toggle.isPending && !reorder.isPending) { setPendingChange(null); toggle.reset(); reorder.reset(); } }}
        eyebrow={t("deployments.confirmChangeEyebrow")}
        title={t(pendingChange?.kind === "reorder" ? "deployments.confirmReorderTitle" : pendingChange?.enabled ? "deployments.confirmEnableTitle" : "deployments.confirmPauseTitle", {
          name: pendingChange?.kind === "toggle" ? pendingChange.name : pendingChange?.integrationName ?? "",
        })}
        description={t(pendingChange?.kind === "reorder" ? "deployments.confirmReorderDescription" : "deployments.confirmToggleDescription")}
        cancelLabel={t("common.cancel")}
        confirmLabel={t(pendingChange?.kind === "reorder" ? "deployments.confirmReorderAction" : pendingChange?.enabled ? "deployments.enable" : "deployments.pause")}
        pendingLabel={t("common.saving")}
        pending={toggle.isPending || reorder.isPending}
        variant={pendingChange?.kind === "toggle" && !pendingChange.enabled ? "warning" : "default"}
        onConfirm={() => {
          if (pendingChange?.kind === "toggle") toggle.mutate({ id: pendingChange.id, enabled: pendingChange.enabled });
          if (pendingChange?.kind === "reorder") reorder.mutate({ integrationId: pendingChange.integrationId, deploymentIds: pendingChange.deploymentIds });
        }}
      >
        <div className="rounded-lg border bg-muted/35 px-4 py-3 text-sm leading-6 text-muted-foreground">
          {t(pendingChange?.kind === "reorder" ? "deployments.confirmReorderImpact" : pendingChange?.enabled ? "deployments.confirmEnableImpact" : "deployments.confirmPauseImpact")}
        </div>
        {toggle.error || reorder.error ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{(toggle.error ?? reorder.error) instanceof Error ? (toggle.error ?? reorder.error)?.message : t("deployments.operationFailed")}</p> : null}
      </ConfirmationSheet>
    </section>
  );
}

function IntegrationRouteTable({
  integration,
  routes,
  guardrails,
  reordering,
  canManage,
  onToggle,
  onReorder,
}: {
  integration: Integration;
  routes: Deployment[];
  guardrails: Guardrail[];
  reordering: boolean;
  canManage: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onReorder: (deploymentIds: string[]) => void;
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
          <div className="min-w-0"><h2 className="truncate text-sm font-semibold">{integration.name}</h2><p className="mt-1 text-xs text-muted-foreground">{integration.protocol.toUpperCase()} · {t("deployments.routeCount", { count: routes.length })}</p></div>
        </div>
        <StateBadge state={integration.enabled ? integration.setup_status : "disabled"} />
      </header>
      <div className="hidden grid-cols-[104px_minmax(160px,1fr)_minmax(220px,1.5fr)_minmax(150px,.8fr)_150px] border-b px-5 py-2.5 text-xs font-medium text-muted-foreground xl:grid">
        <span>{t("deployments.order")}</span><span>{t("deployments.deployment")}</span><span>{t("deployments.trafficScope")}</span><span>{t("deployments.guardrailVersion")}</span><span>{t("common.status")}</span>
      </div>
      <div className="divide-y">
        {routes.map((deployment, index) => {
          const guardrail = guardrails.find((item) => item.id === deployment.guardrail_id);
          const catchAll = !deployment.traffic_scope.conditions.length;
          return (
            <article key={deployment.id} className="grid gap-4 px-5 py-4 xl:grid-cols-[104px_minmax(160px,1fr)_minmax(220px,1.5fr)_minmax(150px,.8fr)_150px] xl:items-center">
              <div className="flex flex-col items-start gap-1">
                <span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                <div className="flex">
                  <Button type="button" variant="ghost" size="icon" className="size-11" aria-label={t("deployments.moveUp", { name: deployment.name })} disabled={!canManage || reordering || catchAll || index === 0} onClick={() => move(index, -1)}><ArrowUp className="size-3.5" /></Button>
                  <Button type="button" variant="ghost" size="icon" className="size-11" aria-label={t("deployments.moveDown", { name: deployment.name })} disabled={!canManage || reordering || catchAll || index >= lastMovableIndex} onClick={() => move(index, 1)}><ArrowDown className="size-3.5" /></Button>
                </div>
              </div>
              <div><Link to="/deployments/$deploymentId" params={{ deploymentId: deployment.id }} className="group inline-flex min-h-11 items-center gap-2 rounded-md outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/30"><ListFilter className="size-4 text-primary" /><strong className="text-sm font-medium">{deployment.name}</strong><ChevronRight className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" /></Link><p className="text-xs text-muted-foreground">{catchAll ? t("deployments.catchAllRoute") : t("deployments.conditionCount", { count: countTrafficConditions(deployment.traffic_scope) })}</p></div>
              <TrafficScopeBadges deployment={deployment} />
              <div><p className="text-xs font-medium">{guardrail?.name ?? deployment.guardrail_id}</p><p className="mt-1 text-xs text-muted-foreground">{t("deployments.version", { version: deployment.guardrail_version })}</p></div>
              <div className="flex items-center justify-between gap-3 xl:justify-start"><StateBadge state={deployment.enabled ? "protected" : "paused"} /><Switch disabled={!canManage} className="after:-inset-y-3.5" aria-label={`${t(deployment.enabled ? "deployments.pause" : "deployments.enable")} ${deployment.name}`} checked={deployment.enabled} onCheckedChange={(enabled) => onToggle(deployment.id, enabled)} /></div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function LegacyDeploymentRow({ deployment, guardrail, onToggle }: { deployment: Deployment; guardrail?: Guardrail; onToggle: (enabled: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <article className="grid gap-4 p-5 lg:grid-cols-[minmax(210px,1.1fr)_minmax(320px,1.8fr)_minmax(155px,.8fr)_132px] lg:items-center">
      <div><Link to="/deployments/$deploymentId" params={{ deploymentId: deployment.id }} className="group inline-flex min-h-11 items-center gap-2 rounded-md outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/30"><ListFilter className="size-4 text-primary" /><strong className="text-sm font-medium">{deployment.name}</strong><ChevronRight className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" /></Link><p className="text-xs text-muted-foreground">{t("deployments.conditionCount", { count: countTrafficConditions(deployment.traffic_scope) })}</p></div>
      <TrafficScopeBadges deployment={deployment} />
      <div><p className="text-xs font-medium">{guardrail?.name ?? deployment.guardrail_id}</p><p className="mt-1 text-xs text-muted-foreground">{t("deployments.version", { version: deployment.guardrail_version })}</p></div>
      <div className="flex items-center justify-between gap-3 lg:justify-start"><StateBadge state={deployment.enabled ? "protected" : "paused"} /><Switch className="after:-inset-y-3.5" aria-label={`${t(deployment.enabled ? "deployments.pause" : "deployments.enable")} ${deployment.name}`} checked={deployment.enabled} onCheckedChange={onToggle} /></div>
    </article>
  );
}

export function TrafficScopeBadges({ deployment }: { deployment: Deployment }) {
  const { t } = useTranslation();
  if (!deployment.traffic_scope.conditions.length) {
    return <span className="text-xs font-medium text-primary">{t(deployment.is_default ? "deployments.unmatchedTraffic" : "deployments.allTraffic")}</span>;
  }
  return <FilterExpressionSummary expression={deployment.traffic_scope} />;
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

export function CreateDeploymentSheet({
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
  const integrationQuery = useQuery({ queryKey: queryKeys.integrations, queryFn: getIntegrations, enabled: open });
  const definitions = fieldQuery.data?.items ?? EMPTY_TRAFFIC_FIELDS;
  const integrations = integrationQuery.data?.items ?? EMPTY_INTEGRATIONS;
  const ready = useMemo(() => guardrails.filter((item) => item.published_current && !item.system_managed && !item.is_default), [guardrails]);
  const [name, setName] = useState("");
  const [guardrailId, setGuardrailId] = useState("");
  const [integrationIds, setIntegrationIds] = useState<string[]>([]);
  const [trafficMode, setTrafficMode] = useState<"all" | "filtered">("all");
  const [filterQuery, setFilterQuery] = useState<TrafficScopeQuery>({ combinator: "and", rules: [] });
  const selectedIntegrations = integrationIds.map((id) => integrations.find((item) => item.id === id)).filter((item): item is Integration => Boolean(item));
  const selectedAdapterId = selectedIntegrations[0]?.adapter_id;
  const selectedProtocol = selectedIntegrations[0]?.protocol;
  const scopeDefinitions = useMemo(
    () => filterDefinitionsForProtocol(definitions, selectedProtocol),
    [definitions, selectedProtocol],
  );
  const integrationOptions: MultiSelectOption[] = integrations.map((integration) => ({
    value: integration.id,
    label: integration.name,
    description: `${integration.protocol.toUpperCase()} · ${t(`integrations.setupStatuses.${integration.setup_status}`)}`,
    meta: integration.adapter_id,
    keywords: [integration.protocol, integration.adapter_id, integration.id],
    disabled: Boolean(selectedAdapterId && integration.adapter_id !== selectedAdapterId),
  }));

  useEffect(() => {
    if (!open) return;
    setName("");
    setIntegrationIds([]);
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
    mutationFn: () => createDeploymentBindings({ name, guardrail_id: guardrailId, integration_ids: integrationIds, traffic_scope: payloadFilter, enabled: true }),
    onSuccess: (result) => { toast.success(t("deployments.createdBindings", { count: result.count })); onCreated(); },
    onError: (error) => notifyError(error, t("deployments.operationFailed")),
  });
  const canCreate = Boolean(name.trim() && guardrailId && integrationIds.length && filterValid && !mutation.isPending);

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={t("deployments.sheetEyebrow")}
      title={t("deployments.sheetTitle")}
      description={t("deployments.sheetDescription")}
      width="xl"
      footer={<><Button className="min-h-11" variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button><Button className="min-h-11" disabled={!canCreate} onClick={() => mutation.mutate()}><ShieldCheck />{t(mutation.isPending ? "deployments.creating" : "deployments.createBindings", { count: integrationIds.length || 1 })}</Button></>}
    >
      {!ready.length ? (
        <EmptyState title={t("deployments.noTestedTitle")} description={t("deployments.noTestedDescription")} />
      ) : (
        <div className="grid gap-7">
          <FormSection number="1" title={t("deployments.trafficSource")} description={t("deployments.trafficSourceDescription")}>
            <Field label={t("deployments.deploymentName")} hint={t("deployments.deploymentNameHint")}><Input autoFocus className="min-h-11 rounded-lg bg-card" value={name} onChange={(event) => setName(event.target.value)} placeholder="Finance production traffic" /></Field>
            {integrationQuery.isLoading ? <Skeleton className="h-24 rounded-lg" /> : null}
            {integrationQuery.error ? <ErrorNotice error={integrationQuery.error} /> : null}
            {!integrationQuery.isLoading && !integrations.length ? (
              <EmptyState title={t("deployments.noIntegrationsTitle")} description={t("deployments.noIntegrationsDescription")} action={<Button className="min-h-11" asChild variant="outline"><Link to="/integrations"><Plus />{t("deployments.createIntegration")}</Link></Button>} />
            ) : integrations.length ? (
              <Field label={t("deployments.gateways")} hint={t("deployments.gatewaysHint")}>
                <MultiSelectCombobox
                  ariaLabel={t("deployments.gateways")}
                  emptyMessage={t("deployments.noMatchingIntegrations")}
                  noOptionsMessage={t("deployments.noIntegrationsTitle")}
                  onValueChange={setIntegrationIds}
                  options={integrationOptions}
                  placeholder={t("deployments.selectGateways")}
                  searchPlaceholder={t("deployments.searchGateways")}
                  value={integrationIds}
                />
              </Field>
            ) : null}
          </FormSection>

          <FormSection number="2" title={t("deployments.trafficWithinSource")} description={t("deployments.trafficWithinSourceDescription")}>
            <RadioGroup value={trafficMode} onValueChange={(value) => setTrafficMode(value as "all" | "filtered")} className="grid gap-3 sm:grid-cols-2">
              <TrafficModeOption value="all" selected={trafficMode === "all"} title={t("deployments.allTraffic")} description={t("deployments.allTrafficDescription")} />
              <TrafficModeOption value="filtered" selected={trafficMode === "filtered"} title={t("deployments.filteredTraffic")} description={t("deployments.filteredTrafficDescription")} />
            </RadioGroup>
            {trafficMode === "filtered" ? (
              <>
                {fieldQuery.isLoading ? <Skeleton className="h-72 rounded-lg" /> : null}
                {fieldQuery.error ? <ErrorNotice error={fieldQuery.error} /> : null}
                {scopeDefinitions.length ? <TrafficScopeBuilder definitions={scopeDefinitions} query={filterQuery} onQueryChange={setFilterQuery} /> : null}
                <InfoNotice title={t("deployments.scopeTrustTitle")}>{t("deployments.scopeTrustDescription")}</InfoNotice>
              </>
            ) : (
              <InfoNotice title={t("deployments.catchAllTitle")}>{t("deployments.catchAllDescription")}</InfoNotice>
            )}
          </FormSection>

          <FormSection number="3" title={t("deployments.applyGuardrail")} description={t("deployments.applyGuardrailDescription")}>
            <Field label={t("deployments.guardrail")}>
              <Select disabled={Boolean(initialGuardrailId)} value={guardrailId} onValueChange={setGuardrailId}><SelectTrigger className="min-h-11 rounded-lg bg-card"><SelectValue /></SelectTrigger><SelectContent className="rounded-lg">{ready.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select>
            </Field>
            {selectedGuardrail ? (
              <div className="grid gap-3 rounded-lg border bg-muted/25 p-4 sm:grid-cols-3">
                <GuardrailFact label={t("deployments.selectedGuardrail")} value={selectedGuardrail.name} />
                <GuardrailFact label={t("guardrails.policies")} value={t("guardrails.policyCount", { count: selectedGuardrail.policy_bindings.length })} />
                <GuardrailFact label={t("guardrails.testEvidence")} value={t("guardrails.testCount", { count: selectedGuardrail.test_case_count })} />
              </div>
            ) : null}
            {selectedGuardrail && selectedIntegrations.length ? (
              <div className="rounded-lg border border-primary/20 bg-primary/[0.04] p-4">
                <p className="text-xs font-medium text-muted-foreground">{t("deployments.effectiveRoute")}</p>
                <p className="mt-1.5 text-sm font-semibold">{t("deployments.effectiveRouteSummary", { count: selectedIntegrations.length, traffic: t(trafficMode === "all" ? "deployments.allTraffic" : "deployments.filteredTraffic"), guardrail: selectedGuardrail.name })}</p>
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

export function filterDefinitionsForProtocol(definitions: TrafficScopeField[], protocol?: Integration["protocol"]) {
  return definitions.filter((item) => {
    if (item.id === "integration.id" || item.id === "protocol") return false;
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
  const translated = t(`deployments.trafficScopeFields.${condition.field.replaceAll(".", "_")}`);
  return condition.key ? `${translated}:${condition.key}` : translated;
}

function operatorLabel(t: (key: string) => string, operator: TrafficCondition["operator"]) {
  return t(`deployments.trafficScopeOperators.${operator}`);
}

function notifyError(error: unknown, fallback: string) { toast.error(error instanceof Error ? error.message : fallback); }
