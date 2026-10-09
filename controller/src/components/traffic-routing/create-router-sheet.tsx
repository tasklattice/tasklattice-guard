import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, CircleAlert, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { EntitySheet } from "@/components/entity-sheet";
import { CreationFlow, ReviewList, WizardSection } from "@/components/creation-flow";
import { ErrorNotice, InfoNotice } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { listControllerEndpoints, listControllerGuardrails } from "@/lib/controller-api";
import { createTrafficRouter, getSelectorFields, listTrafficRouters, trafficRouterKeys, type TrafficRoute } from "@/lib/traffic-routing-api";
import { routingIssues } from "../../../shared/traffic-routing";
import { percent } from "./form";
import { selectorSummary } from "./router-view-model";
import { SelectorEditor } from "./selector-editor";
import { TargetsEditor } from "./targets-editor";
import "./create-router-sheet.scss";

const newRoute = (kind: TrafficRoute["kind"]): TrafficRoute => ({
  id: crypto.randomUUID(),
  name: i18n.t(kind === "fallback" ? "routing.fallback" : "routing.route"),
  kind,
  enabled: true,
  selector: { expression: { combinator: "and", conditions: [] } },
  targets: [],
});

export function CreateRouterSheet({ open, onOpenChange, onCreated }: {
  open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void;
}) {
  const { t } = useTranslation();
  const nameId = useId();
  const blockedReasonId = useId();
  const [step, setStep] = useState(0);
  const steps = [
    { label: t("routing.routerName"), description: t("routing.createSections.nameHint") },
    { label: t("routing.createSections.ingress"), description: t("routing.createSections.ingressHint") },
    { label: t("routing.createSections.destinations"), description: t("routing.createSections.destinationsNavigationHint") },
    { label: t("routing.createSections.review"), description: t("routing.createSections.reviewHint") },
  ];
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [endpointIds, setEndpointIds] = useState<string[]>([]);
  const [routes, setRoutes] = useState(() => [newRoute("normal")]);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [fallback, setFallback] = useState(() => newRoute("fallback"));
  const endpoints = useQuery({ queryKey: ["routing-source-endpoints"], queryFn: listControllerEndpoints, enabled: open });
  const routers = useQuery({ queryKey: trafficRouterKeys.all, queryFn: listTrafficRouters, enabled: open });
  const guardrails = useQuery({ queryKey: ["routing-guardrails"], queryFn: listControllerGuardrails, enabled: open });
  const fields = useQuery({ queryKey: ["routing-fields", endpointIds], queryFn: () => getSelectorFields(endpointIds), enabled: open && endpointIds.length > 0 });
  const draft = {
    routes: [...routes.map((route, index) => ({
      ...route, name: t("routing.createSections.ruleName", { number: index + 1 }),
    })), fallback],
  };
  const issues = routingIssues(draft, true);
  const mutation = useMutation({
    mutationFn: () => createTrafficRouter({ name: name.trim(), endpointIds, draft }),
    networkMode: "always",
    retry: false,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: trafficRouterKeys.all });
      onCreated();
    },
  });
  const options = (endpoints.data?.items ?? []).map(endpoint => {
    const owner = routers.data?.items.find(router => router.endpointIds.includes(endpoint.id));
    return {
      value: endpoint.id, label: endpoint.name, meta: endpoint.adapter, disabled: Boolean(owner),
      description: owner ? `${t("routing.boundTo")} ${owner.name}` : undefined,
    };
  });
  const updateRoute = (next: TrafficRoute) => setRoutes(current => current.map(route => route.id === next.id ? next : route));
  const moveRoute = (id: string, direction: -1 | 1) => setRoutes(current => {
    const from = current.findIndex(route => route.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= current.length) return current;
    const next = [...current];
    [next[from], next[to]] = [next[to]!, next[from]!];
    return next;
  });
  const sourceIssue = !routers.data || !endpoints.data
    ? t(endpoints.error || routers.error ? "routing.createSections.sourcesUnavailable" : "routing.createSections.sourcesLoading")
    : !endpointIds.length ? t("routing.createSections.chooseEndpoints") : null;
  const destinationIssue = issues.length ? t("routing.completeTheConditionsAndGuardrailsForEachRuleDistribution") : null;
  const blockedReason = !name.trim()
    ? t("routing.createSections.enterName")
    : step >= 1 && sourceIssue ? sourceIssue
      : step >= 2 ? destinationIssue : null;
  const canCreate = Boolean(name.trim() && !sourceIssue && !destinationIssue && !mutation.isPending);
  const changeStep = (next: number) => { if (!mutation.isPending) setStep(next); };
  const targetSummary = (route: TrafficRoute) => route.targets.map(target => {
    const guardrail = guardrails.data?.items.find(item => item.id === target.guardrailId);
    return `${guardrail?.name ?? t("routing.chooseAGuardRail")} · ${target.guardrailVersion || "—"} · ${percent(target.weightBps)}`;
  }).join(" / ") || "—";

  return (
    <EntitySheet width="workflow" bodyClassName="overflow-hidden p-0 sm:p-0" open={open} closeDisabled={mutation.isPending} onOpenChange={onOpenChange}
      eyebrow={t("routing.router")} title={t("routing.createRouter")}
      description={t("routing.selectIncomingTrafficAndRouteItToGuardrails")}
      footer={<div className="w-full space-y-3">
        {mutation.error && <ErrorNotice error={mutation.error} />}
        <div className="flex w-full items-center gap-3">
          {blockedReason && <p id={blockedReasonId} role="status" className="mr-auto flex min-w-0 flex-1 items-start gap-2 text-left text-xs leading-5 text-amber-800">
            <CircleAlert className="mt-0.5 size-4 shrink-0" /><span>{blockedReason}</span>
          </p>}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button variant="outline" disabled={mutation.isPending} onClick={() => step ? changeStep(step - 1) : onOpenChange(false)}>
              {step ? <><ArrowLeft />{t("common.previous")}</> : t("common.cancel")}
            </Button>
            {step < steps.length - 1 ? <Button disabled={Boolean(blockedReason)}
              aria-describedby={blockedReason ? blockedReasonId : undefined} title={blockedReason ?? undefined}
              onClick={() => changeStep(step + 1)}>
              {t(step === 2 ? "routing.createSections.toReview" : "common.next")}<ArrowRight />
            </Button> : <Button disabled={!canCreate} aria-describedby={blockedReason ? blockedReasonId : undefined}
              onClick={() => mutation.mutate()}>
              {mutation.isPending && <LoaderCircle className="animate-spin" />}
              {t(mutation.isPending ? "routing.creating" : "routing.createRouter")}
            </Button>}
          </div>
        </div>
      </div>}>
      <CreationFlow orientation="sidebar" freelyNavigable contained currentStep={step} onStepChange={changeStep}
        steps={steps} progressLabel={t("routing.initialRoutingConfiguration")}>
      <fieldset className="create-router-form" disabled={mutation.isPending}>
        <legend className="sr-only">{t("routing.initialRoutingConfiguration")}</legend>
        {step === 0 && <WizardSection title={t("routing.routerName")} description={t("routing.createSections.nameDescription")}>
          <div className="grid gap-2">
          <Label htmlFor={nameId}>{t("routing.routerName")} *</Label>
          <Input id={nameId} autoFocus aria-label={t("routing.routerName")} className="field:min-h-11 field:bg-card" maxLength={160}
            placeholder={t("routing.createSections.namePlaceholder")}
            value={name} onChange={event => setName(event.target.value)} />
          </div>
        </WizardSection>}

        {step === 1 && <WizardSection title={t("routing.createSections.ingress")} description={t("routing.createSections.sourceDescription")}>
          <p className="cds--label">{t("routing.sourceEndpoints")} *</p>
          <MultiSelectCombobox ariaLabel={t("routing.sourceEndpoints")} options={options} value={endpointIds}
            onValueChange={setEndpointIds} disabled={endpoints.isPending || routers.isPending || mutation.isPending}
            placeholder={t("routing.searchOrSelectEndpoints")} />
          <p className="create-router-help">{t("routing.selectedEndpointsShareTheseRulesEachEndpointBelongsTo")}</p>
          {endpoints.error && <ErrorNotice error={endpoints.error} />}
          {routers.error && <ErrorNotice error={routers.error} />}
          {(endpoints.error || routers.error) && <Button className="mt-3" variant="outline"
            onClick={() => { void endpoints.refetch(); void routers.refetch(); }}>{t("common.retry")}</Button>}
        </WizardSection>}

        {step === 2 && <WizardSection title={t("routing.createSections.destinations")} description={t("routing.createSections.destinationsDescription")}>
          <div className="create-router-subheading">
            <h4>{t("routing.createSections.conditionalRoutes")}</h4>
            <p>{t("routing.createSections.firstMatch")}</p>
          </div>
          {fields.error && <ErrorNotice error={fields.error} />}
          {!routes.length && <p className="create-router-empty">{t("routing.createSections.noConditions")}</p>}
          <div className="create-router-rules">
            {routes.map((route, index) => {
              const expanded = !collapsed.includes(route.id);
              const title = t("routing.createSections.ruleName", { number: index + 1 });
              const targetSummary = route.targets.map(target => {
                const guardrail = guardrails.data?.items.find(item => item.id === target.guardrailId);
                return `${guardrail?.name ?? t("routing.chooseAGuardRail")} · ${percent(target.weightBps)}`;
              }).join(" / ");
              return (
                <article key={route.id} className="create-router-rule" aria-label={title}>
                  <div className="create-router-rule-heading">
                    <h5>{title}</h5>
                    <div className="create-router-rule-actions">
                      {routes.length > 1 && <>
                        <Button variant="ghost" size="icon-sm" disabled={index === 0 || mutation.isPending}
                          aria-label={t("routing.createSections.moveUp", { name: title })} onClick={() => moveRoute(route.id, -1)}><ArrowUp /></Button>
                        <Button variant="ghost" size="icon-sm" disabled={index === routes.length - 1 || mutation.isPending}
                          aria-label={t("routing.createSections.moveDown", { name: title })} onClick={() => moveRoute(route.id, 1)}><ArrowDown /></Button>
                      </>}
                      <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={`create-route-${route.id}`}
                        onClick={() => setCollapsed(current => expanded ? [...current, route.id] : current.filter(id => id !== route.id))}>
                        <ChevronDown className={expanded ? "rotate-180" : undefined} />
                        {t(expanded ? "routing.createSections.collapse" : "routing.createSections.expand")}
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={t("routing.createSections.remove", { name: title })}
                        onClick={() => {
                          setRoutes(current => current.filter(item => item.id !== route.id));
                          setCollapsed(current => current.filter(id => id !== route.id));
                        }}><Trash2 /></Button>
                    </div>
                  </div>
                  {!expanded && <div className="create-router-rule-summary">
                    <p>{selectorSummary(route.selector.expression)}</p>
                    <ArrowRight aria-hidden="true" />
                    <p>{targetSummary || t("routing.chooseAGuardRail")}</p>
                  </div>}
                  <div id={`create-route-${route.id}`} className="create-router-rule-body" hidden={!expanded}>
                    <div className="create-router-rule-part">
                      <h6><span>IF</span>{t("routing.createSections.matchConditions")}</h6>
                      <SelectorEditor value={route.selector.expression} fields={fields.data?.items}
                        onChange={expression => updateRoute({ ...route, selector: { expression } })} />
                    </div>
                    <div className="create-router-rule-part create-router-rule-targets">
                      <h6><span>THEN</span>{t("routing.forwardTo")}</h6>
                      <TargetsEditor value={route.targets} onChange={targets => updateRoute({ ...route, targets })} />
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
          <Button variant="outline" className="create-router-add-rule" disabled={routes.length >= 127}
            onClick={() => {
              setCollapsed(routes.map(route => route.id));
              setRoutes(current => [...current, newRoute("normal")]);
            }}><Plus />{t("routing.createSections.addRoute")}</Button>

          <section className="create-router-fallback" aria-label={t("routing.createSections.fallback")}>
            <div className="create-router-subheading">
              <h4>{t("routing.createSections.fallback")}</h4>
              <p>{t("routing.createSections.fallbackOrder")}</p>
            </div>
            <p className="create-router-help">{t(routes.length ? "routing.oneGuardRailReceives100OfUnmatchedTraffic" : "routing.createSections.allTrafficFallback")}</p>
            <TargetsEditor fallback value={fallback.targets} onChange={targets => setFallback(current => ({ ...current, targets }))} />
          </section>
        </WizardSection>}
        {step === 3 && <WizardSection title={t("routing.createSections.reviewTitle")} description={t("routing.createSections.reviewDescription")}>
          <InfoNotice>{t("routing.createSections.savedAsDraft")}</InfoNotice>
          <div className="mt-4">
            <ReviewList items={[
              { label: t("routing.routerName"), value: name.trim() || "—" },
              { label: t("routing.sourceEndpoints"), value: endpointIds.map(id => endpoints.data?.items.find(endpoint => endpoint.id === id)?.name ?? id).join(", ") || "—" },
            ]} />
          </div>
          <div className="mt-4 divide-y overflow-hidden rounded-lg border bg-card">
            {draft.routes.map((route, index) => <button type="button" key={route.id}
              disabled={mutation.isPending} onClick={() => changeStep(2)}
              className="block min-h-12 w-full px-4 py-3 text-left text-sm hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <span className="block font-medium">{route.kind === "fallback" ? t("routing.createSections.fallback") : t("routing.createSections.ruleName", { number: index + 1 })}</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">{route.kind === "fallback" ? t("routing.trafficThatMatchesNoneOfTheRulesIsForwarded") : selectorSummary(route.selector.expression)}</span>
              <span className="mt-1 block break-words">{targetSummary(route)}</span>
            </button>)}
          </div>
          <Button variant="edit" className="mt-4 min-h-11" onClick={() => changeStep(2)}>{t("routing.createSections.editDestinations")}</Button>
        </WizardSection>}
      </fieldset>
      </CreationFlow>
    </EntitySheet>
  );
}
