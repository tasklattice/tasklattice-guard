import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
import { useId, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowRight, ArrowUp, ChevronDown, Plus, Trash2 } from "lucide-react";
import { EntitySheet } from "@/components/entity-sheet";
import { ErrorNotice } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

function CreationSection({ number, title, hint, children }: {
  number: string; title: string; hint?: string; children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="create-router-section" aria-labelledby={headingId}>
      <div className="create-router-section-heading">
        <span className="create-router-section-number" aria-hidden="true">{number}</span>
        <h3 id={headingId}>{title}</h3>
        {hint && <span className="create-router-section-hint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export function CreateRouterSheet({ open, onOpenChange, onCreated }: {
  open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void;
}) {
  const { t } = useTranslation();
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
  const readiness = !name.trim()
    ? t("routing.createSections.enterName")
    : !endpointIds.length
      ? t("routing.createSections.chooseEndpoints")
      : issues.length
        ? t("routing.completeTheConditionsAndGuardrailsForEachRuleDistribution")
        : t("routing.createSections.savedAsDraft");

  return (
    <EntitySheet width="xl" open={open} closeDisabled={mutation.isPending} onOpenChange={onOpenChange}
      eyebrow={t("routing.router")} title={t("routing.createRouter")}
      description={t("routing.selectIncomingTrafficAndRouteItToGuardrails")}
      footer={<>
        <p className="create-router-readiness" role="status">{readiness}</p>
        <Button variant="outline" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>{t("routing.cancel")}</Button>
        <Button variant="create" disabled={!name.trim() || !endpointIds.length || issues.length > 0 || mutation.isPending || !routers.data || !endpoints.data}
          onClick={() => mutation.mutate()}>{mutation.isPending ? t("routing.creating") : t("routing.createRouter")}</Button>
      </>}>
      <fieldset className="create-router-form" disabled={mutation.isPending}>
        <legend className="sr-only">{t("routing.initialRoutingConfiguration")}</legend>
        <CreationSection number="01" title={t("routing.routerName")}>
          <Input autoFocus aria-label={t("routing.routerName")} maxLength={160}
            placeholder={t("routing.createSections.namePlaceholder")}
            value={name} onChange={event => setName(event.target.value)} />
        </CreationSection>

        <CreationSection number="02" title={t("routing.createSections.ingress")} hint={t("routing.createSections.ingressHint")}>
          <MultiSelectCombobox ariaLabel={t("routing.sourceEndpoints")} options={options} value={endpointIds}
            onValueChange={setEndpointIds} disabled={endpoints.isPending || routers.isPending || mutation.isPending}
            placeholder={t("routing.searchOrSelectEndpoints")} />
          <p className="create-router-help">{t("routing.selectedEndpointsShareTheseRulesEachEndpointBelongsTo")}</p>
          {endpoints.error && <ErrorNotice error={endpoints.error} />}
          {routers.error && <ErrorNotice error={routers.error} />}
        </CreationSection>

        <CreationSection number="03" title={t("routing.createSections.destinations")} hint={t("routing.createSections.destinationsHint")}>
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
        </CreationSection>
        {mutation.error && <ErrorNotice error={mutation.error} />}
      </fieldset>
    </EntitySheet>
  );
}
