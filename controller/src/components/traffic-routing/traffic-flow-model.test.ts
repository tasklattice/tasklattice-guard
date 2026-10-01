import { describe, expect, it } from "vitest";
import type { Endpoint } from "@/lib/api";
import type { TrafficRoute } from "@/lib/traffic-routing-api";
import { buildTrafficFlow, flowLayout } from "./traffic-flow-model";

const endpoint = (id = "local", enabled = true) => ({ id, enabled } as Endpoint);
const route = (id: string, options: Partial<TrafficRoute> = {}): TrafficRoute => ({
  id, name: id, kind: "normal", enabled: true,
  selector: { expression: { combinator: "and", conditions: [] } },
  targets: [{ id: "target", guardrailId: "guard", guardrailVersion: "v1", weightBps: 10000 }],
  ...options,
});
const fallback = route("fallback", { kind: "fallback" });
const id = (...parts: string[]) => JSON.stringify(parts);

describe("Published traffic decision graph", () => {
  it("connects a fallback-only router directly without an orphan unmatched node", () => {
    const graph = buildTrafficFlow({ routes: [fallback] }, [endpoint()]);
    expect(graph.nodes.map(n => n.data.kind)).toEqual(["endpoint", "rule", "target"]);
    expect(graph.edges.map(e => [e.source, e.target, e.data?.kind])).toEqual([
      [id("endpoint", "local"), id("rule", "fallback"), "entry"],
      [id("rule", "fallback"), id("target", "fallback", "target"), "fallback"],
    ]);
    expect(new Set(graph.nodes.map(n => n.position.y)).size).toBe(1);
  });

  it("enters the first enabled rule and advances only through no-match edges", () => {
    const graph = buildTrafficFlow({ routes: [route("disabled", { enabled: false }), route("first"), route("skipped", { enabled: false }), route("second"), fallback] }, [endpoint("one"), endpoint("two"), endpoint("off", false)]);
    expect(graph.edges.filter(e => e.data?.kind === "entry").map(e => [e.source, e.target])).toEqual([
      [id("endpoint", "one"), id("rule", "first")], [id("endpoint", "two"), id("rule", "first")],
    ]);
    expect(graph.edges.filter(e => e.data?.kind === "miss").map(e => [e.source, e.sourceHandle, e.target, e.targetHandle])).toEqual([
      [id("rule", "first"), "miss", id("rule", "second"), "previous"],
      [id("rule", "second"), "miss", id("rule", "fallback"), "previous"],
    ]);
    expect(graph.disabled.map(d => d.ordinal)).toEqual([1, 3]);
    expect(graph.nodes.filter(n => n.data.kind === "rule").map(n => n.data.kind === "rule" && n.data.ordinal)).toEqual([2, 4, 0]);
    expect(graph.nodes.some(n => n.id === id("rule", "disabled"))).toBe(false);
  });

  it("keeps each split attached to its rule even when targets and versions are reused", () => {
    const split = route("split", { targets: [
      { id: "target", guardrailId: "guard", guardrailVersion: "v1", weightBps: 7500 },
      { id: "canary", guardrailId: "guard", guardrailVersion: "v2", weightBps: 2500 },
      { id: "zero", guardrailId: "guard", guardrailVersion: "v3", weightBps: 0 },
    ] });
    const graph = buildTrafficFlow({ routes: [split, fallback] }, [endpoint()]);
    expect(graph.edges.filter(e => e.data?.kind === "match").map(e => e.data?.weightBps)).toEqual([7500, 2500]);
    expect(graph.nodes.filter(n => n.data.kind === "target")).toHaveLength(4);
    expect(new Set(graph.nodes.map(n => n.id)).size).toBe(graph.nodes.length);
    expect(graph.edges.every(e => graph.nodes.some(n => n.id === e.source) && graph.nodes.some(n => n.id === e.target))).toBe(true);
    // Distribution rows cannot overlap, including the larger fan-out above fallback.
    const targetNodes = graph.nodes.filter(n => n.data.kind === "target");
    for (let i = 1; i < targetNodes.length; i++) expect(targetNodes[i].position.y - targetNodes[i - 1].position.y).toBeGreaterThanOrEqual(flowLayout.height + flowLayout.gap);
  });

  it("shows unattached configuration without inventing incoming traffic", () => {
    const graph = buildTrafficFlow({ routes: [route("disabled", { enabled: false }), fallback] }, []);
    expect(graph.nodes[0].data.kind).toBe("empty");
    expect(graph.edges.map(e => e.data?.kind)).toEqual(["fallback"]);
    expect(graph.height).toBeGreaterThan(flowLayout.height);
  });
});
