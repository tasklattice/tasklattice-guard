import "@/i18n";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { endpointSetupStates } from "../../../shared/lifecycle";
import type { Endpoint } from "@/lib/api";
import { EndpointSetupBadge } from "../endpoint-setup-badge";
import { TrafficFlow } from "./traffic-flow";
import type { TrafficFlowNode } from "./traffic-flow-model";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Right: "right", Left: "left", Top: "top", Bottom: "bottom" },
  MarkerType: { ArrowClosed: "arrowclosed" },
  ReactFlow: ({ nodes, nodeTypes }: { nodes: TrafficFlowNode[]; nodeTypes: { traffic: React.ComponentType<{ data: TrafficFlowNode["data"] }> } }) => {
    const Node = nodeTypes.traffic;
    return <>{nodes.map(node => <Node key={node.id} data={node.data} />)}</>;
  },
}));
afterEach(cleanup);

describe("Traffic Flow Endpoint status", () => {
  it.each(endpointSetupStates)("reuses the Endpoints setup badge for %s regardless of runtime health", setup_status => {
    const { container } = render(<>
      <div data-testid="endpoint-status"><EndpointSetupBadge status={setup_status} /></div>
      <TrafficFlow snapshot={{ routes: [] }} endpoints={[{
        id: "endpoint", name: "Gateway", protocol: "scan", enabled: setup_status !== "disabled",
        setup_status, runtime_status: "degraded",
      } as Endpoint]} guardrails={[]} onRule={() => {}} />
    </>);
    const expected = screen.getByTestId("endpoint-status").querySelector("[data-slot=badge]")!;
    const actual = container.querySelector("a [data-slot=badge]")!;
    expect(actual.textContent).toBe(expected.textContent);
    expect(actual.className).toBe(expected.className);
    expect(screen.queryByText("Unhealthy")).toBeNull();
    expect(screen.queryByText("Health unknown")).toBeNull();
  });
});
