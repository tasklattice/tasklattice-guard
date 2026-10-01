import { useTranslation } from "react-i18next";
import { ArrowRight, Cable, GitBranch, ShieldCheck } from "lucide-react";
import type { Endpoint } from "@/lib/api";
import type {
  RouterRevision,
  TrafficRouter,
} from "@/lib/traffic-routing-api";
import { Button } from "../ui/button";
import "./router-workspace.scss";
import { revisionLabel } from "./router-view-model";
import { TrafficFlow } from "./traffic-flow";

type Names = Array<{ id: string; name: string }>;
export function RouterOverview({
  router,
  endpoints,
  guardrails,
  revisions,
  onRule,
  onEndpoints,
  onRouting,
  canEdit,
}: {
  router: TrafficRouter;
  endpoints: Endpoint[];
  guardrails: Names;
  revisions: RouterRevision[];
  canEdit: boolean;
  onRule: (id: string) => void;
  onEndpoints: () => void;
  onRouting: () => void;
}) {
  const { t: localize } = useTranslation();
  const snapshot = router.activeSnapshot;
  const revision = revisions.find((r) => r.revision === router.activeRevision);
  const versions = new Set(
    snapshot?.routes.flatMap((r) =>
      r.targets.map((t) => `${t.guardrailId}:${t.guardrailVersion}`),
    ) ?? [],
  );
  const healthy = endpoints.filter(e => e.runtime_status === "healthy").length;
  const unhealthy = endpoints.filter(e => e.runtime_status === "degraded").length;
  const unknown = endpoints.filter(e => e.enabled && !["healthy", "degraded"].includes(e.runtime_status)).length;
  const disabled = endpoints.filter(e => !e.enabled).length;
  const normalRules = snapshot?.routes.filter(r => r.kind === "normal") ?? [];
  return (
    <div className="router-overview">
      <div className="router-overview-metrics">
        <div><button type="button" className="router-metric-label" onClick={onEndpoints}><Cable aria-hidden="true" />{localize("routing.endpoints2")}<ArrowRight aria-hidden="true" /></button><strong>{endpoints.length}</strong><span className="router-metric-detail">{localize("routing.healthyCount", { count: healthy })}{unhealthy ? localize("routing.needAttentionCount", { count: unhealthy }) : ''}{unknown ? localize("routing.unknownCount", { count: unknown }) : ''}{disabled ? localize("routing.disabledCount", { count: disabled }) : ''}</span></div>
        <div><button type="button" className="router-metric-label" onClick={onRouting}><GitBranch aria-hidden="true" />{localize("routing.publishedRoutingRules")}<ArrowRight aria-hidden="true" /></button><strong>{normalRules.length}</strong><span className="router-metric-detail">{snapshot ? localize("routing.fallbackCount", { count: snapshot.routes.filter(r => r.kind === "fallback").length }) : localize("routing.noPublishedRuleSet")}</span></div>
        <div><span className="router-metric-label"><ShieldCheck aria-hidden="true" />{localize("routing.guardrailVersions")}</span><strong>{versions.size}</strong><span className="router-metric-detail">{snapshot ? localize("routing.pinnedInThePublishedRevision") : localize("routing.assignedWhenARevisionIsPublished")}</span></div>
      </div>
      <section className="router-overview-panel router-flow-panel" aria-label={localize("routing.trafficFlow")}>
        <header className="router-panel-heading">
          <div><h2>{localize("routing.trafficFlow")}</h2><p>{snapshot ? localize("routing.flowDescription", { revision: revisionLabel(revision) }) : localize("routing.noRevisionHasBeenPublishedDraftRulesAreNot")}</p></div>
        </header>
        {!endpoints.length && <div className="router-endpoint-notice"><Cable aria-hidden="true" /><p>{localize("routing.noEndpointsAreAttachedToThisRouter")}</p><Button variant="ghost" onClick={onEndpoints}>{canEdit ? localize("routing.attachEndpoint") : localize("routing.viewEndpoints")}</Button></div>}
        {snapshot ? <TrafficFlow snapshot={snapshot} endpoints={endpoints} guardrails={guardrails} onRule={onRule} /> : <div className="router-flow-empty">
          <div className="router-flow-stages" aria-hidden="true"><span><Cable /><span>{localize("routing.endpoint")}</span></span><ArrowRight /><span><GitBranch /><span>{localize("routing.routing")}</span></span><ArrowRight /><span><ShieldCheck /><span>{localize("routing.guardrail")}</span></span></div>
          <h3>{localize("routing.trafficFlowAppearsAfterTheFirstPublication")}</h3>
          <p>{localize("routing.configureRoutingRulesAndChooseGuardrailVersionsThenReview")}</p>
          <Button variant="outline" onClick={onRouting}>{localize("routing.viewRouting")}</Button>
        </div>}
      </section>
    </div>
  );
}
