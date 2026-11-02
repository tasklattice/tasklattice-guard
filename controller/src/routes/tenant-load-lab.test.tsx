import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { controlTenantLoadLab, getTenantLoadLabState, type LabSample, type LabTenantId, type TenantLoadLabState } from "@/lib/tenant-load-lab-api";
import { TenantLoadLabPage } from "./tenant-load-lab";
import { tenantLoadLabEn, tenantLoadLabZh } from "@/tenant-load-lab-i18n";

const identity = vi.hoisted(() => ({ role: "admin" as string | null, language: "en" }));
vi.mock("@/components/tenant-admission-monitor", () => ({ TenantAdmissionMonitorPanel: () => null }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: identity.role ? { id: "admin", role: identity.role } : null }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: identity.language },
  t: (key: string) => key === "tenantLoadLab" ? (identity.language.startsWith("zh") ? tenantLoadLabZh : tenantLoadLabEn) : key }) }));
vi.mock("@/lib/tenant-load-lab-api", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/tenant-load-lab-api")>(),
  getTenantLoadLabState: vi.fn(), controlTenantLoadLab: vi.fn(),
}));
vi.mock("recharts", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { ResponsiveContainer: Container, LineChart: ({ children, data }: { children?: ReactNode; data: unknown[] }) => <div data-testid="measured-chart" data-points={data.length}>{children}</div>, CartesianGrid: () => null, Line: () => null, ReferenceLine: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null };
});

const ids: LabTenantId[] = ["tenantA", "tenantB", "tenantC"];
function snapshot(input: Partial<TenantLoadLabState> = {}): TenantLoadLabState {
  return {
    running: false, mode: "shared", sampleIntervalMs: 1_000,
    fakeLlm: { fixedLatencyMs: 120, p95Ms: null, active: 0, capacity: 1024, completed: 0 },
    runner: { ready: true, inflight: 0, queue: 0, capacity: 8, cpuPercent: null, memoryMiB: null },
    tenants: ids.map(id => ({ id, name: id, color: "#000", groupId: id === "tenantC" ? "group-c" : "group-ab", groupName: id === "tenantC" ? "C group" : "A + B group", poolId: id === "tenantC" ? "pool-c" : "pool-ab", slotBudget: 4, inflight: 0, queued: 0, offeredRps: 1, completedRps: 0, occupancyPercent: 0, p50Ms: null, p95Ms: null, guardP95Ms: null, modelP95Ms: null, queueP95Ms: null, errors: 0, completed: 0, peakUntil: null })),
    groups: [{ id: "group-ab", name: "A + B group", tenantIds: ["tenantA", "tenantB"], poolIds: ["pool-ab"], runner: { ready: true, metricsAvailable: true, inflight: 0, queue: 0, capacity: 8 } }, { id: "group-c", name: "C group", tenantIds: ["tenantC"], poolIds: ["pool-c"], runner: { ready: true, metricsAvailable: true, inflight: 0, queue: 0, capacity: 4 } }],
    history: [], events: [], limits: { maxRps: 32, maxInflight: 24, queueLimit: 48 }, measurement: { occupancyDefinition: "client inflight / four slots", quotaSimulation: false, runnerMetricsAvailable: true },
    ...input,
  };
}
let client: QueryClient;
function renderPage() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><TenantLoadLabPage /></QueryClientProvider>);
}
beforeEach(() => {
  identity.role = "admin"; identity.language = "en";
  vi.mocked(getTenantLoadLabState).mockReset().mockResolvedValue(snapshot());
  vi.mocked(controlTenantLoadLab).mockReset().mockImplementation(async input => snapshot({ running: input.action === "start", mode: input.mode ?? "shared" }));
});
afterEach(() => { cleanup(); client?.clear(); vi.useRealTimers(); });

describe("Tenant Load Lab", () => {
  it("discloses dedicated real protection targets and the fake application model", async () => {
    renderPage();
    const disclosure = screen.getByRole("note", { name: "Real protection, dedicated lab targets" });
    expect(within(disclosure).getByText(/Actual Runner Endpoints → Routers → published Guardrail/)).toBeTruthy();
    expect(within(disclosure).getByText(/simple keyword policy \(LAB_BLOCK_MARKER\)/)).toBeTruthy();
    expect(within(disclosure).getByText(/real Input check → local fake application model \(120 ms\) → real Output check/)).toBeTruthy();
    expect(within(disclosure).getByText(/lab fixtures, not existing business pipelines or an external gateway/)).toBeTruthy();
    expect(await screen.findByText("Only application generation is fake · no external inference")).toBeTruthy();
  });

  it("keeps policy blocks and transformations separate from errors and delivered traffic", async () => {
    const state = snapshot();
    state.tenants[0] = { ...state.tenants[0], blocked: 9, inputBlocked: 4, outputBlocked: 5, transformed: 3, completed: 70, completedRps: 6, errors: 2 };
    vi.mocked(getTenantLoadLabState).mockResolvedValue(state);
    renderPage();
    const decisions = await screen.findByRole("group", { name: "Tenant A · Policy decisions" });
    expect(within(decisions).getAllByRole("term").map(element => element.textContent)).toEqual(["Blocked", "Transformed", "Input blocked", "Output blocked"]);
    expect(within(decisions).getAllByRole("definition").map(element => element.textContent)).toEqual(["9", "3", "4", "5"]);
    expect(within(decisions).queryByText(/errors/)).toBeNull();
    const tenant = screen.getByRole("article", { name: "Tenant A" });
    expect(within(tenant).getByText("70 delivered")).toBeTruthy();
    expect(within(tenant).getByText("2 errors")).toBeTruthy();
    expect(screen.getByText(/Delivered rate and latency exclude blocked requests/)).toBeTruthy();
  });

  it("defaults missing policy counters to zero for an older snapshot", async () => {
    renderPage();
    const decisions = await screen.findByRole("group", { name: "Tenant A · Policy decisions" });
    expect(within(decisions).getAllByRole("definition").map(element => element.textContent)).toEqual(["0", "0", "0", "0"]);
  });

  it("starts measured traffic and pauses the experiment through the control API", async () => {
    renderPage();
    const start = await screen.findByRole("button", { name: "Start experiment" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(controlTenantLoadLab).toHaveBeenCalledWith({ action: "start" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(controlTenantLoadLab).toHaveBeenLastCalledWith({ action: "stop" }));
  });

  it("uses the selected duration and tenant for a peak and can release it", async () => {
    const active = snapshot({ running: true });
    vi.mocked(getTenantLoadLabState).mockResolvedValue(active);
    vi.mocked(controlTenantLoadLab).mockImplementation(async input => ({ ...active, tenants: active.tenants.map(tenant => tenant.id === input.tenantId ? { ...tenant, peakUntil: Date.now() + 60_000 } : tenant) }));
    renderPage();
    await screen.findByText("Measured group traffic");
    fireEvent.change(screen.getByRole("combobox", { name: "Peak duration" }), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Peak for 60s · Tenant B" }));
    await waitFor(() => expect(controlTenantLoadLab).toHaveBeenCalledWith({ action: "peak", tenantId: "tenantB", durationSeconds: 60 }));
    fireEvent.click(await screen.findByRole("button", { name: "Release peak · Tenant B" }));
    await waitFor(() => expect(controlTenantLoadLab).toHaveBeenLastCalledWith({ action: "release", tenantId: "tenantB" }));
  });

  it("labels quota controls as client-side simulation rather than production isolation", async () => {
    renderPage();
    const tab = await screen.findByRole("tab", { name: "Quota simulation" });
    await waitFor(() => expect(tab.hasAttribute("disabled")).toBe(false));
    fireEvent.click(tab);
    await waitFor(() => expect(controlTenantLoadLab).toHaveBeenCalledWith({ action: "mode", mode: "quota" }));
    expect(await screen.findByText("Quota simulation (client-side)")).toBeTruthy();
    expect(screen.getByText(/production per-tenant CPU and rate quotas are not configured here/)).toBeTruthy();
    expect(screen.getByText(/It is not tenant CPU utilization/)).toBeTruthy();
  });

  it("renders empty measured charts and unavailable telemetry without invented series", async () => {
    const unavailable = snapshot();
    vi.mocked(getTenantLoadLabState).mockResolvedValue({ ...unavailable, groups: unavailable.groups.map(group => ({ ...group, runner: { ...group.runner, metricsAvailable: false, cpuPercent: 90, memoryMiB: 200 } })) });
    renderPage();
    expect(await screen.findByText("Waiting for measured samples")).toBeTruthy();
    expect(screen.queryByTestId("measured-chart")).toBeNull();
    expect(screen.getAllByText("Waiting for Runner resource telemetry")).toHaveLength(2);
    const runnerTile = screen.getByRole("article", { name: "A + B group · Runner group measurements" });
    expect(within(runnerTile).getAllByText("—", { exact: false }).length).toBeGreaterThan(0);
    expect(within(runnerTile).queryByText("90%")).toBeNull();
    expect(screen.getByText("No events yet. Start an experiment to begin.")).toBeTruthy();
  });

  it("shows initial connection loading and retries a failed state request", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(getTenantLoadLabState).mockReturnValueOnce(new Promise((_resolve, failed) => { reject = failed; }));
    renderPage();
    expect(screen.getByRole("status").textContent).toContain("Connecting to the load lab");
    await act(async () => reject(new Error("Runner connection unavailable")));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Runner connection unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    expect(await screen.findByText("Measured group traffic")).toBeTruthy();
  });

  it("reports control errors without pretending the experiment started", async () => {
    vi.mocked(controlTenantLoadLab).mockRejectedValue(new Error("Runner is not synchronized"));
    renderPage();
    const start = await screen.findByRole("button", { name: "Start experiment" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fireEvent.click(start);
    expect(await screen.findByText("Runner is not synchronized")).toBeTruthy();
    expect(screen.getByText("Experiment control failed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("shows peer impact only from measured baseline and peak windows", async () => {
    const start = Date.now() - 10_000;
    const metric = (p95Ms: number) => ({ occupancyPercent: 50, p95Ms, guardP95Ms: p95Ms - 120, modelP95Ms: 120, queueP95Ms: 0, completedRps: 1 });
    const history: LabSample[] = [-3, -2, -1, 0, 1, 2].map(offset => ({ time: start + offset * 1_000, tenantA: metric(240), tenantB: metric(offset < 0 ? 200 : 400), tenantC: metric(200) }));
    const data = snapshot({ history, events: [{ id: "peak-a", time: start, tenantId: "tenantA", kind: "peak", message: "Tenant A peak started" }, { id: "release-a", time: start + 4_000, tenantId: "tenantA", kind: "release", message: "Tenant A peak ended" }] });
    vi.mocked(getTenantLoadLabState).mockResolvedValue(data);
    renderPage();
    expect(await screen.findByText("+100%")).toBeTruthy();
    expect(screen.getByText("400 ms")).toBeTruthy();
    expect(screen.getAllByTestId("measured-chart")).toHaveLength(3);
    expect(screen.getByText("Same group")).toBeTruthy();
    expect(screen.getByText("Separate group")).toBeTruthy();
  });

  it("passes the query abort signal and does not request private state for non-admins", async () => {
    const view = renderPage();
    await waitFor(() => expect(getTenantLoadLabState).toHaveBeenCalled());
    const signal = vi.mocked(getTenantLoadLabState).mock.calls[0][0]!;
    expect(signal).toBeInstanceOf(AbortSignal);
    view.unmount();
    client.clear();
    identity.role = "user";
    vi.mocked(getTenantLoadLabState).mockClear();
    renderPage();
    expect(screen.getByRole("alert").textContent).toContain("Platform administrator access");
    expect(getTenantLoadLabState).not.toHaveBeenCalled();
  });

  it("provides Chinese experiment controls without global i18n mutations", async () => {
    identity.language = "zh-CN";
    renderPage();
    expect(await screen.findByRole("heading", { name: "租户负载实验室" })).toBeTruthy();
    expect(await screen.findByText("实测租户组流量")).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始实验" })).toBeTruthy();
    const disclosure = screen.getByRole("note", { name: "真实防护，实验专用目标" });
    expect(within(disclosure).getByText(/简单的关键词策略（LAB_BLOCK_MARKER）/)).toBeTruthy();
    expect(within(disclosure).getByText(/本实验使用专用测试配置，不测试已有业务流水线或外部网关/)).toBeTruthy();
    expect(screen.getByRole("group", { name: "租户 A · 策略决策" })).toBeTruthy();
  });

  it("shows A and B sharing one measured group and C using a separate pool", async () => {
    const state = snapshot();
    state.groups[0].runner = { ready: true, metricsAvailable: true, inflight: 6, queue: 3, capacity: 8, cpuPercent: 27.5, memoryMiB: 140 };
    state.groups[1].runner = { ready: true, metricsAvailable: true, inflight: 1, queue: 0, capacity: 4, cpuPercent: 3.2, memoryMiB: 81 };
    state.runner = { ...state.runner, inflight: 999, cpuPercent: 999 };
    vi.mocked(getTenantLoadLabState).mockResolvedValue(state);
    renderPage();
    const shared = await screen.findByRole("article", { name: "A + B group · Runner group measurements" });
    expect(within(shared).getByText("Tenant A")).toBeTruthy();
    expect(within(shared).getByText("Tenant B")).toBeTruthy();
    expect(within(shared).queryByText("Tenant C")).toBeNull();
    expect(within(shared).getByText("Runner pool: pool-ab")).toBeTruthy();
    expect(within(shared).getByText("27.5%")).toBeTruthy();
    expect(within(shared).getByText("140")).toBeTruthy();
    const separate = screen.getByRole("article", { name: "C group · Runner group measurements" });
    expect(within(separate).getByText("Tenant C")).toBeTruthy();
    expect(within(separate).getByText("Runner pool: pool-c")).toBeTruthy();
    expect(within(separate).getByText("3.2%")).toBeTruthy();
    expect(screen.queryByText("999%")).toBeNull();
    expect(screen.getByText(/Placement labels describe this lab’s configured allocation/)).toBeTruthy();
    expect(screen.getByText(/share the local node and Redis/)).toBeTruthy();
  });

  it("does not invent group placement when the experiment reports none", async () => {
    vi.mocked(getTenantLoadLabState).mockResolvedValue(snapshot({ groups: [] }));
    renderPage();
    expect(await screen.findByText("No group allocation reported")).toBeTruthy();
    expect(screen.queryByRole("article", { name: /Runner group measurements/ })).toBeNull();
    expect(screen.queryByText(/All three test tenants send real checks to the shared Runner/)).toBeNull();
  });
});
