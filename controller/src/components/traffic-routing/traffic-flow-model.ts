import type { Node, Edge } from "@xyflow/react";
import type { Endpoint } from "@/lib/api";
import type { RouterDraft, TrafficRoute, RouteTarget } from "@/lib/traffic-routing-api";

export const flowLayout = {
  width: 1032,
  padding: 24,
  height: 144,
  gap: 24,
  rowGap: 80,
  endpoint: { x: 24, width: 224 },
  rule: { x: 348, width: 256 },
  target: { x: 744, width: 264 },
};

type FlowData =
  | { kind: "endpoint"; endpoint: Endpoint }
  | { kind: "empty" }
  | { kind: "rule"; route: TrafficRoute; ordinal: number; entry: boolean; previous: boolean; miss: boolean }
  | { kind: "target"; target: RouteTarget };
export type TrafficFlowNode = Node<FlowData, "traffic">;
export type TrafficFlowEdge = Edge<{ kind: "entry" | "match" | "fallback" | "miss"; weightBps?: number }>;
const nodeId = (...parts: string[]) => JSON.stringify(parts);
const stackHeight = (count: number) => Math.max(1, count) * (flowLayout.height + flowLayout.gap) - flowLayout.gap;

/** Model the published first-match decision chain. React Flow owns ports and edge routing. */
export function buildTrafficFlow(snapshot: RouterDraft, endpoints: Endpoint[]) {
  const { height, padding, rowGap, endpoint, rule, target } = flowLayout;
  const normal = snapshot.routes.filter(r => r.kind === "normal");
  const disabled = normal.flatMap((route, index) => route.enabled ? [] : [{ route, ordinal: index + 1 }]);
  const routes = [
    ...normal.filter(r => r.enabled),
    ...snapshot.routes.filter(r => r.kind === "fallback" && r.enabled),
  ];
  const nodes: TrafficFlowNode[] = [];
  const edges: TrafficFlowEdge[] = [];
  const addNode = (id: string, column: { x: number; width: number }, y: number, data: FlowData) => {
    nodes.push({ id, type: "traffic", position: { x: column.x, y }, width: column.width, height, data });
  };
  let y = padding;
  const firstHeight = Math.max(stackHeight(endpoints.length), stackHeight(routes[0]?.targets.length ?? 0));
  if (!endpoints.length) addNode(nodeId("empty"), endpoint, y + (firstHeight - height) / 2, { kind: "empty" });
  endpoints.forEach((e, index) => {
    const id = nodeId("endpoint", e.id);
    addNode(id, endpoint, padding + (firstHeight - stackHeight(endpoints.length)) / 2 + index * (height + flowLayout.gap), { kind: "endpoint", endpoint: e });
    if (e.enabled && routes[0]) edges.push({ id: nodeId("entry", e.id), source: id, sourceHandle: "out", target: nodeId("rule", routes[0].id), targetHandle: "entry", data: { kind: "entry" } });
  });
  routes.forEach((route, index) => {
    const rowHeight = index === 0 ? firstHeight : stackHeight(route.targets.length);
    const id = nodeId("rule", route.id);
    addNode(id, rule, y + (rowHeight - height) / 2, { kind: "rule", route, ordinal: normal.indexOf(route) + 1, entry: index === 0 && endpoints.some(e => e.enabled), previous: index > 0, miss: index < routes.length - 1 });
    route.targets.forEach((t, targetIndex) => {
      const targetId = nodeId("target", route.id, t.id);
      addNode(targetId, target, y + (rowHeight - stackHeight(route.targets.length)) / 2 + targetIndex * (height + flowLayout.gap), { kind: "target", target: t });
      // A zero-weight target is configured but does not receive traffic.
      if (t.weightBps > 0) edges.push({ id: nodeId("distribution", route.id, t.id), source: id, sourceHandle: "match", target: targetId, targetHandle: "in", data: { kind: route.kind === "fallback" ? "fallback" : "match", weightBps: t.weightBps } });
    });
    const next = routes[index + 1];
    if (next) edges.push({ id: nodeId("miss", route.id), source: id, sourceHandle: "miss", target: nodeId("rule", next.id), targetHandle: "previous", data: { kind: "miss" } });
    y += rowHeight + rowGap;
  });
  return { nodes, edges, disabled, height: Math.max(firstHeight + padding * 2, y - rowGap + padding) };
}
