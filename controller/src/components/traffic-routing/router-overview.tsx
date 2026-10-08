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
  return (
    <div className="router-overview">
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
