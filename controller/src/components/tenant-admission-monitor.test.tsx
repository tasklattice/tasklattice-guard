// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { admissionMonitorKey, getAdmissionMonitor, type AdmissionMonitorState } from "@/lib/admission-monitor-api";
import { TenantAdmissionMonitorPanel } from "./tenant-admission-monitor";

vi.mock("@/lib/admission-monitor-api", async original => ({ ...await original<typeof import("@/lib/admission-monitor-api")>(), getAdmissionMonitor: vi.fn() }));
vi.mock("recharts", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { ResponsiveContainer: Container, LineChart: ({ children, data }: { children?: ReactNode; data: unknown[] }) => <div data-testid="admission-chart" data-points={data.length}>{children}</div>,
    Line: ({ connectNulls }: { connectNulls: boolean }) => <span data-testid="admission-line" data-connect-nulls={String(connectNulls)} />,
    CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null };
});
const values = { active: 1, queued: 2, capacity: 2, occupancyPercent: 50, attempts: 12, admitted: 10, rejected: 2, cancelled: 0,
  attemptsPerSecond: 1.2, admittedPerSecond: 1, rejectedPerSecond: 0.2, waitP95Ms: 25, heldP95Ms: 300 };
function state(): AdmissionMonitorState {
  const entity = (id: string, name: string, groupId: string, tenantIds: string[], poolIds: string[]) => ({ id, name, groupId, tenantIds, poolIds,
    available: true, intervalAvailable: true, reason: null, reportingSources: 1, expectedSources: 1, values,
    history: [{ at: 1700000000000, values }] });
  return { observedAt: 1700000000000, source: "authenticated_runner_heartbeat", controllerLocal: true, staleAfterMs: 30000, available: true, reason: null,
    selectedPoolId: null, pools: [{ id: "pool-ab", name: "Shared A/B", groupId: "ab" }, { id: "pool-c", name: "Isolated C", groupId: "c" }],
    groups: [entity("ab", "A + B", "ab", ["tenantA", "tenantB"], ["pool-ab"]), entity("c", "C isolated", "c", ["tenantC"], ["pool-c"])],
    tenants: [entity("tenantA", "Tenant A", "ab", ["tenantA"], ["pool-ab"]), entity("tenantB", "Tenant B", "ab", ["tenantB"], ["pool-ab"]), entity("tenantC", "Tenant C", "c", ["tenantC"], ["pool-c"])], sources: [] };
}
let client: QueryClient;
const mount = (seed = false) => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  if (seed) client.setQueryData([...admissionMonitorKey, ""], state());
  return render(<QueryClientProvider client={client}><TenantAdmissionMonitorPanel /></QueryClientProvider>);
};
beforeEach(() => { vi.mocked(getAdmissionMonitor).mockReset().mockResolvedValue(state()); });
afterEach(() => { cleanup(); client?.clear(); });
describe("actual admission monitor panel", () => {
  it("shows measured group placement and bounded pool selection without browser metric URLs", async () => {
    mount(); const group = await screen.findByRole("article", { name: "Measured group A + B" });
    expect(within(group).getByText("tenantA + tenantB · pool-ab")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Measured group C isolated" })).getByText("tenantC · pool-c")).toBeTruthy();
    expect(screen.getByRole("figure", { name: "Group admission wait p95 · histogram estimate" })).toBeTruthy();
    expect(screen.getAllByTestId("admission-line").every(row => row.getAttribute("data-connect-nulls") === "false")).toBe(true);
    fireEvent.change(screen.getByLabelText("Admission source pool"), { target: { value: "pool-c" } });
    await waitFor(() => expect(getAdmissionMonitor).toHaveBeenLastCalledWith("pool-c", expect.any(AbortSignal)));
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("renders absent measurements as unavailable with empty charts", async () => {
    const snapshot = state(); snapshot.available = false;
    for (const row of [...snapshot.groups, ...snapshot.tenants]) {
      row.available = false; row.intervalAvailable = false; row.reason = "stale"; row.history = [];
      row.values = Object.fromEntries(Object.keys(values).map(key => [key, null])) as typeof values;
    }
    vi.mocked(getAdmissionMonitor).mockResolvedValue(snapshot);
    mount(); const group = await screen.findByRole("article", { name: "Measured group A + B" });
    expect(within(group).getByText("— / — permits")).toBeTruthy(); expect(within(group).getByText(/Heartbeat stale/)).toBeTruthy();
    expect(screen.getAllByTestId("admission-chart").every(row => row.getAttribute("data-points") === "0")).toBe(true);
  });
  it("does not keep cached current values looking live after a failed refresh", async () => {
    vi.mocked(getAdmissionMonitor).mockRejectedValue(new Error("private upstream connection detail"));
    mount(true);
    expect((await screen.findByRole("alert")).textContent).toContain("Admission measurements are unavailable");
    expect(within(screen.getByRole("article", { name: "Measured group A + B" })).getByText("— / — permits")).toBeTruthy();
    expect(screen.queryByText("private upstream connection detail")).toBeNull();
  });
});
