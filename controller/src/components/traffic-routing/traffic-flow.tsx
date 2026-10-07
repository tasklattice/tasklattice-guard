import { createContext, useContext, useId, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { Handle, MarkerType, Position, ReactFlow, type NodeProps } from "@xyflow/react";
import { Cable, GitBranch, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EndpointProtocolIcon } from "@/components/endpoint-protocol-icon";
import type { Endpoint } from "@/lib/api";
import type { RouterDraft } from "@/lib/traffic-routing-api";
import { conditionCount, selectorSummary } from "./router-view-model";
import { buildTrafficFlow, flowLayout, type TrafficFlowNode } from "./traffic-flow-model";
import { percent } from "./form";
import "./traffic-flow.scss";

type Props = {
  snapshot: RouterDraft;
  endpoints: Endpoint[];
  guardrails: Array<{ id: string; name: string }>;
  onRule: (id: string) => void;
};
const FlowContext = createContext<Pick<Props, "guardrails" | "onRule">>({ guardrails: [], onRule: () => {} });

function TrafficNode({ data }: NodeProps<TrafficFlowNode>) {
  const { t } = useTranslation();
  const { guardrails, onRule } = useContext(FlowContext);
  if (data.kind === "empty") return <div className="router-flow-card router-flow-card-empty"><Cable aria-hidden="true" /><span>{t("routing.noAttachedEndpoints2")}</span></div>;
  if (data.kind === "endpoint") {
    const e = data.endpoint;
    const status = !e.enabled ? "disabled" : e.runtime_status === "healthy" ? "healthy2" : e.runtime_status === "degraded" ? "unhealthy" : "healthUnknown";
    return <>
      <Link to="/integration/endpoints" search={{ endpointId: e.id }} className="router-flow-card nodrag" title={e.name}>
        <span className="router-flow-title"><EndpointProtocolIcon protocol={e.protocol} size="sm" /><span>{e.name}</span></span>
        <span className={`router-flow-status router-flow-status-${status}`}>● {t(`routing.${status}`)}</span>
      </Link>
      {e.enabled && <Handle type="source" position={Position.Right} id="out" isConnectable={false} />}
    </>;
  }
  if (data.kind === "target") {
    const target = data.target;
    const name = guardrails.find(g => g.id === target.guardrailId)?.name ?? t("routing.guardRailUnavailable");
    return <>
      {target.weightBps > 0 && <Handle type="target" position={Position.Left} id="in" isConnectable={false} />}
      <a className="router-flow-card nodrag" href={`/guardrails/${encodeURIComponent(target.guardrailId)}`} title={`${name} · ${target.guardrailVersion || t("routing.versionUnavailable")}`}>
        <span className="router-flow-title"><ShieldCheck aria-hidden="true" /><span>{name}</span></span>
        <span className="router-flow-version">{target.guardrailVersion || t("routing.versionUnavailable")}</span>
        {target.weightBps === 0 && <span className="router-flow-detail">{t("routing.zeroWeightTarget")}</span>}
      </a>
    </>;
  }
  const { route, ordinal } = data;
  const fallback = route.kind === "fallback";
  const summary = fallback ? t("routing.usedWhenNoRoutingRulesMatch") : selectorSummary(route.selector.expression);
  return <>
    <Handle type="target" position={Position.Left} id="entry" isConnectable={false} style={{ visibility: data.entry ? "visible" : "hidden" }} />
    <Handle type="target" position={Position.Top} id="previous" isConnectable={false} style={{ visibility: data.previous ? "visible" : "hidden" }} />
    <button type="button" className={`router-flow-card nodrag ${fallback ? "router-flow-card-fallback" : ""}`} onClick={() => onRule(route.id)}>
      <span className="router-flow-title" title={route.name}><GitBranch aria-hidden="true" /><span>{fallback ? t("routing.fallback") : `${String(ordinal).padStart(2, "0")} · ${route.name}`}</span></span>
      <span className="router-flow-detail router-flow-summary" title={summary}>{summary}</span>
      {!fallback && <span className="router-flow-detail">{t("routing.conditionCount", { count: conditionCount(route.selector.expression) })}</span>}
    </button>
    {route.targets.some(target => target.weightBps > 0) && <Handle type="source" position={Position.Right} id="match" isConnectable={false} />}
    <Handle type="source" position={Position.Bottom} id="miss" isConnectable={false} style={{ visibility: data.miss ? "visible" : "hidden" }} />
  </>;
}
const nodeTypes = { traffic: TrafficNode };
const viewport = { x: 0, y: 0, zoom: 1 };

export function TrafficFlow({ snapshot, endpoints, guardrails, onRule }: Props) {
  const { t } = useTranslation();
  const descriptionId = useId();
  const graph = useMemo(() => buildTrafficFlow(snapshot, endpoints), [snapshot, endpoints]);
  const nodeLabel = (id: string) => {
    const data = graph.nodes.find(node => node.id === id)?.data;
    if (data?.kind === "endpoint") return data.endpoint.name;
    if (data?.kind === "rule") return data.route.kind === "fallback" ? t("routing.fallback") : data.route.name;
    if (data?.kind === "target") return `${guardrails.find(g => g.id === data.target.guardrailId)?.name ?? t("routing.guardRailUnavailable")} · ${data.target.guardrailVersion}`;
    return "";
  };
  const edges = useMemo(() => graph.edges.map(edge => {
    const miss = edge.data?.kind === "miss";
    const color = miss ? "var(--cds-text-secondary)" : "var(--cds-link-primary)";
    const label = miss ? t("routing.flowNoMatch") : edge.data?.weightBps !== undefined ? percent(edge.data.weightBps) : undefined;
    return {
      ...edge,
      type: "smoothstep",
      label,
      ariaLabel: `${nodeLabel(edge.source)} → ${nodeLabel(edge.target)}${label ? ` · ${label}` : ""}`,
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
      style: { stroke: color, strokeWidth: 1.5, ...(miss ? { strokeDasharray: "5 4" } : {}) },
      labelStyle: { fill: "var(--cds-text-primary)", fontSize: 12 },
      labelBgStyle: { fill: "var(--cds-layer-02)" },
      labelBgPadding: [8, 5] as [number, number],
      pathOptions: { borderRadius: 8 },
    };
  }), [graph, guardrails, t]);
  return <div className="router-traffic-flow">
    <div className="router-flow-legend" id={descriptionId}>
      <span><i aria-hidden="true" />{t("routing.flowDistribution")}</span>
      {graph.edges.some(edge => edge.data?.kind === "miss") && <span><i className="router-flow-legend-miss" aria-hidden="true" />{t("routing.flowNoMatch")}</span>}
      <span className="router-flow-scroll-hint">{t("routing.flowScrollHint")}</span>
    </div>
    <div className="router-flow-scroll" role="region" tabIndex={0} aria-label={t("routing.publishedTrafficFlow")} aria-describedby={descriptionId}>
      <div className="router-flow-canvas" style={{ width: flowLayout.width }}>
        <div className="router-flow-headings">
          <h3 style={{ left: flowLayout.endpoint.x, width: flowLayout.endpoint.width }}>{t("routing.endpoints2")}</h3>
          <h3 style={{ left: flowLayout.rule.x, width: flowLayout.rule.width }}>{t("routing.routingRulesFirstMatchWins")}</h3>
          <h3 style={{ left: flowLayout.target.x, width: flowLayout.target.width }}>{t("routing.guardRailsPinnedVersions")}</h3>
        </div>
        <FlowContext.Provider value={{ guardrails, onRule }}>
          <div style={{ height: graph.height }}>
            <ReactFlow<TrafficFlowNode>
              nodes={graph.nodes} edges={edges} nodeTypes={nodeTypes}
              defaultViewport={viewport} minZoom={1} maxZoom={1}
              nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}
              nodesFocusable={false} edgesFocusable={false}
              panOnDrag={false} panOnScroll={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false}
              preventScrolling={false} autoPanOnNodeFocus={false}
              attributionPosition="bottom-left"
            />
          </div>
        </FlowContext.Provider>
      </div>
    </div>
    {graph.disabled.length > 0 && <div className="router-flow-skipped">
      <p>{t("routing.flowDisabledRules")}</p>
      {graph.disabled.map(({ route, ordinal }) => <button type="button" key={route.id} onClick={() => onRule(route.id)}>{String(ordinal).padStart(2, "0")} · {route.name}<span>{t("routing.disabled")}</span></button>)}
    </div>}
  </div>;
}
