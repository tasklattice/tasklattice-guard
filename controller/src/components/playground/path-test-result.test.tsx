import "@/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PathTestResult } from "./path-test-result";
import type { PathTestRecord } from "./use-path-workbench";

afterEach(cleanup);
const item = {
  id: "test", createdAt: "2026-10-13T09:00:00Z", label: "Support router", configuration: "Published r1",
  input: { target: "router", targetId: "router-id", action: "simulate", callId: "test-call" },
  result: { status: 200, durationMs: 10, callId: "test-call", body: {
    simulation: true, runnerId: "runner-0",
    assignment: { endpointId: "endpoint-id", routerId: "router-id", routerRevision: 1, routeId: "route-id", guardrailId: "guard-id", guardrailVersion: "v1" },
    rules: [{ routeId: "route-id", name: "Support", state: "selected", targets: [{ guardrailId: "guard-id", guardrailVersion: "v1", weightBps: 10000 }] }, { routeId: "other", name: "Other", state: "not_evaluated" }],
  } },
} as PathTestRecord;
function mount(record = item) {
  render(<PathTestResult item={record} guardrailNames={{ "guard-id": "Privacy" }} routerNames={{ "router-id": "Support router" }} endpointNames={{ "endpoint-id": "Support API" }} />);
}
function tab(name: string) { fireEvent.click(screen.getByRole("tab", { name }), { button: 0, ctrlKey: false }); }
describe("path test trace", () => {
  it("resolves assignment names and keeps diagnostic identifiers in the raw response", () => {
    mount();
    expect(screen.getByText("Support API")).toBeTruthy();
    expect(screen.getByText("Support router · r1")).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getByText("Not evaluated")).toBeTruthy();
    expect(screen.queryByText(/endpoint-id/)).toBeNull();
    expect(screen.queryByText(/runner-0/)).toBeNull();
    tab("Raw response");
    expect(screen.getByText("test-call")).toBeTruthy();
    expect(screen.getByText(/"endpointId": "endpoint-id"/)).toBeTruthy();
  });
  it("does not present routing-only simulation as a Guardrail evaluation", () => {
    mount(); tab("Evaluation");
    expect(screen.getByText("This request only checked routing; no GuardRail was executed.")).toBeTruthy();
    expect(screen.queryByText("Decision: allow")).toBeNull();
  });
  it("shows an outcome once without hiding a distinct reason or action", () => {
    mount({ ...item, result: { ...item.result!, body: { decision: { decision: "block", action: "block", reason: "Sensitive content" } } } });
    tab("Evaluation");
    expect(screen.getByText("Decision: block")).toBeTruthy();
    expect(screen.queryByText("block", { exact: true })).toBeNull();
    expect(screen.getByText("Sensitive content")).toBeTruthy();
    expect(screen.getByText("Test scope").closest("details")?.open).toBe(false);
  });
});
