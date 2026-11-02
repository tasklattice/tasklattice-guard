import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControllerRequestError } from "@/lib/controller-api";
import { listRunnerPools, type RunnerPool } from "@/lib/controller-api";
import type { ReactNode } from "react";
import * as api from "@/lib/tenant-groups-api";
import { TenantGroupsPage } from "./tenant-groups";

const identity = vi.hoisted(() => ({ role: "admin", language: "en" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: identity.role } }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) => <a {...props} href={to}>{children}</a> }));
vi.mock("@/lib/controller-api", async original => ({ ...await original<typeof import("@/lib/controller-api")>(), listRunnerPools: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: identity.language }, t: (key: string) => key }) }));
vi.mock("@/components/ui/notifications", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-groups-api", async original => ({
  ...await original<typeof import("@/lib/tenant-groups-api")>(), getTenantGroups: vi.fn(), createTenantGroup: vi.fn(), renameTenantGroup: vi.fn(), deleteTenantGroup: vi.fn(), assignTenantGroup: vi.fn(), assignRunnerPoolGroup: vi.fn(), registerGroupRunnerPool: vi.fn(), updateRunnerPoolConnectivity: vi.fn(),
}));

let directory: api.TenantGroupDirectory;
let client: QueryClient;
function fixture(): api.TenantGroupDirectory {
  const date = "2026-10-27T00:00:00Z";
  return {
    items: [
      { id: "default", name: "Default group", isDefault: true, tenantIds: ["tenantA"], poolIds: ["default"], createdAt: date, updatedAt: date },
      { id: "team-a", name: "Team A", isDefault: false, tenantIds: ["tenantB"], poolIds: ["edge-a"], createdAt: date, updatedAt: date },
      { id: "team-b", name: "Team B", isDefault: false, tenantIds: [], poolIds: [], createdAt: date, updatedAt: date },
    ],
    tenants: [{ id: "tenantA", name: "Tenant A", groupId: "default" }, { id: "tenantB", name: "Tenant B", groupId: "team-a" }],
    pools: [
      { id: "default", name: "GuardRails 0", groupId: "default", isDefault: true, runtimeUrl: null, publicUrl: null, instances: [{ runnerId: "default-0", status: "ready" }] },
      { id: "edge-a", name: "Team A runtime", groupId: "team-a", isDefault: false, runtimeUrl: "http://edge-a:8091", publicUrl: null, instances: [{ runnerId: "edge-a-0", status: "offline" }] },
    ],
  };
}
function renderPage() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><TenantGroupsPage /></QueryClientProvider>);
}
async function openTab(name: string) { fireEvent.click(await screen.findByRole("tab", { name })); }
beforeEach(() => {
  identity.role = "admin"; identity.language = "en"; directory = fixture();
  vi.mocked(api.getTenantGroups).mockReset().mockImplementation(async () => directory);
  vi.mocked(listRunnerPools).mockReset().mockResolvedValue({ items: [] });
  for (const fn of [api.createTenantGroup, api.renameTenantGroup, api.deleteTenantGroup, api.assignTenantGroup, api.assignRunnerPoolGroup, api.registerGroupRunnerPool, api.updateRunnerPoolConnectivity]) vi.mocked(fn).mockReset().mockResolvedValue(undefined as never);
});
afterEach(() => { cleanup(); client?.clear(); });

describe("Tenant groups administration", () => {
  it("creates a named group while leaving default and occupied groups protected", async () => {
    renderPage();
    const create = await screen.findByRole("button", { name: "Create group" });
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("button", { name: "Delete · Default group" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Delete · Team A" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(create);
    const sheet = screen.getByRole("dialog");
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Name" }), { target: { value: "Priority customers" } });
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Group ID" }), { target: { value: "priority" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Create group" }));
    await waitFor(() => expect(api.createTenantGroup).toHaveBeenCalledWith({ id: "priority", name: "Priority customers" }));
  });

  it("moves a tenant with the reviewed source-group token", async () => {
    renderPage(); await openTab("Tenant membership");
    fireEvent.click(screen.getByRole("button", { name: "Change group · Tenant B" }));
    const sheet = screen.getByRole("dialog");
    fireEvent.change(within(sheet).getByRole("combobox", { name: "Target group" }), { target: { value: "default" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Apply assignment" }));
    await waitFor(() => expect(api.assignTenantGroup).toHaveBeenCalledWith("tenantB", "default", "team-a"));
    expect(api.assignRunnerPoolGroup).not.toHaveBeenCalled();
  });

  it("blocks a tenant move while its old group has connected Runners", async () => {
    renderPage(); await openTab("Tenant membership");
    fireEvent.click(screen.getByRole("button", { name: "Change group · Tenant A" }));
    const sheet = screen.getByRole("dialog");
    fireEvent.change(within(sheet).getByRole("combobox", { name: "Target group" }), { target: { value: "team-a" } });
    expect(within(sheet).getByText(/Connected Runners prevent this move/)).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Apply assignment" }).hasAttribute("disabled")).toBe(true);
    expect(api.assignTenantGroup).not.toHaveBeenCalled();
  });

  it("requires an explicit refresh and review before retrying a stale assignment", async () => {
    vi.mocked(api.assignTenantGroup).mockRejectedValueOnce(new ControllerRequestError("The tenant group changed", 409));
    renderPage(); await openTab("Tenant membership");
    fireEvent.click(screen.getByRole("button", { name: "Change group · Tenant B" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Target group" }), { target: { value: "default" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply assignment" }));
    expect(await screen.findByText("The tenant group changed")).toBeTruthy();
    expect(api.assignTenantGroup).toHaveBeenCalledTimes(1);
    directory = { ...directory, tenants: directory.tenants.map(tenant => tenant.id === "tenantB" ? { ...tenant, groupId: "team-b" } : tenant) };
    fireEvent.click(screen.getByRole("button", { name: "Refresh and review" }));
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Target group" }) as HTMLSelectElement).value).toBe("team-b"));
    fireEvent.change(screen.getByRole("combobox", { name: "Target group" }), { target: { value: "default" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply assignment" }));
    await waitFor(() => expect(api.assignTenantGroup).toHaveBeenLastCalledWith("tenantB", "default", "team-b"));
  });

  it("pre-registers a pool with validated service origins without promising Pod creation", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Register Runner pool · Team A" }));
    const sheet = screen.getByRole("dialog");
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Runner pool ID" }), { target: { value: "edge-new" } });
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Name" }), { target: { value: "New runtime" } });
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Internal runtime URL" }), { target: { value: "http://runner-new:8091/private" } });
    expect(within(sheet).getByRole("button", { name: "Register Runner pool" }).hasAttribute("disabled")).toBe(true);
    expect(within(sheet).getByText(/Registration does not create or scale Kubernetes/)).toBeTruthy();
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Internal runtime URL" }), { target: { value: "http://runner-new:8091" } });
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Public runtime URL" }), { target: { value: "https://runtime.example.com" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Register Runner pool" }));
    await waitFor(() => expect(api.registerGroupRunnerPool).toHaveBeenCalledWith("team-a", { id: "edge-new", name: "New runtime", runtimeUrl: "http://runner-new:8091", publicUrl: "https://runtime.example.com" }));
  });

  it("keeps the default pool fixed and allocates an offline pool with expectedGroupId", async () => {
    renderPage(); await openTab("Runner allocation");
    expect(screen.getByRole("button", { name: "Change group · GuardRails 0" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Change group · Team A runtime" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Target group" }), { target: { value: "team-b" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply assignment" }));
    await waitFor(() => expect(api.assignRunnerPoolGroup).toHaveBeenCalledWith("edge-a", "team-b", "team-a"));
  });

  it("edits connectivity while requiring an explicit internal origin for group-owned pools", async () => {
    renderPage(); await openTab("Runner allocation");
    fireEvent.click(screen.getByRole("button", { name: "Connectivity · Team A runtime" }));
    const sheet = screen.getByRole("dialog");
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Internal runtime URL" }), { target: { value: "" } });
    expect(within(sheet).getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Internal runtime URL" }), { target: { value: "http://edge-a-new:8091" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.updateRunnerPoolConnectivity).toHaveBeenCalledWith("edge-a", { runtimeUrl: "http://edge-a-new:8091", publicUrl: null }));
  });

  it("requires the empty group's ID before deletion", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Delete · Team B" }));
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByRole("button", { name: "Delete" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Type the group ID to confirm" }), { target: { value: "team-b" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteTenantGroup).toHaveBeenCalledWith("team-b"));
  });

  it("retries directory errors and passes cancellation to the state request", async () => {
    vi.mocked(api.getTenantGroups).mockRejectedValueOnce(new Error("Directory unavailable"));
    renderPage();
    expect(await screen.findByText("Directory unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Rename · Team A" })).toBeTruthy();
    expect(vi.mocked(api.getTenantGroups).mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });

  it("does not fetch platform inventory for tenant users", () => {
    identity.role = "user";
    renderPage();
    expect(screen.getByText("Platform administrator access is required.")).toBeTruthy();
    expect(api.getTenantGroups).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Create group" })).toBeNull();
  });

  it("provides Chinese group and allocation controls", async () => {
    identity.language = "zh-CN";
    renderPage();
    expect(screen.getByRole("heading", { name: "租户组", level: 1 })).toBeTruthy();
    expect(await screen.findByRole("tab", { name: "Runner 分配" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "创建租户组" })).toBeTruthy();
  });

  it("aggregates only the group's serving Runner measurements and distinguishes unavailable telemetry", async () => {
    const pool: RunnerPool = {
      id: "edge-a", name: "Team A runtime", isDefault: false, desiredReplicas: 1, safeRpsPerRunner: 10, maxConcurrencyPerRunner: 8,
      instances: [{ runnerId: "edge-a-0", bootId: "boot", poolId: "edge-a", status: "ready", runnerVersion: "0.2.0", nemoVersion: "0.24.0", compilerCapable: false, maxConcurrency: 8, desiredGeneration: 1, appliedGeneration: 1, lastHeartbeatAt: "2026-10-27T00:00:00Z", load: { inflight: 3, maxConcurrency: 8, queueDepth: 2, requestsDelta: 10, errorsDelta: 0, timeoutsDelta: 0, latencyP95Ms: 245, cpuUtilization: 0.2, memoryUtilization: 0.3, activeGuardrails: 1, compileQueueDepth: 0, observationIntervalMs: 1000 } }],
      capacity: { readyRunners: 1, totalRunners: 1, currentRps: 10, safeRpsCapacity: 10, utilization: 0.3, inflightUtilization: 0.375, cpuUtilization: 0.2, memoryUtilization: 0.3, queueDepth: 2, errorRate: 0, worstRunnerLatencyP95Ms: 245, latencyP95Ms: 245, recommendedReplicas: 1, headroomRps: 0 },
    };
    vi.mocked(listRunnerPools).mockResolvedValue({ items: [pool] });
    renderPage();
    const group = await screen.findByRole("article", { name: "Live group capacity · Team A" });
    await waitFor(() => expect(within(group).getByText("3 / 8")).toBeTruthy());
    expect(within(group).getByText("245 ms")).toBeTruthy();
    const unmeasured = screen.getByRole("article", { name: "Live group capacity · Team B" });
    expect(within(unmeasured).getAllByText("—")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Runner monitoring" }).getAttribute("href")).toBe("/settings/runner");
  });
});
