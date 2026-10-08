import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runnerViewEn } from "@/runner-view-i18n";
import type { RunnerPool } from "@/lib/controller-api";

import { RunnerCapacitySection } from "./runner-capacity";

const mocks = vi.hoisted(() => ({
  listRunnerPools: vi.fn(),
  removeRunnerInstance: vi.fn(),
  updateRunnerPool: vi.fn(),
  role: "admin",
  toastSuccess: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const labels: Record<string, string> = {
        "runners.title": "Runner capacity",
        "runners.convergence.converged": "Configuration converged",
        "runners.convergence.syncing": "Configuration syncing",
        "runners.convergence.unavailable": "No connected Runners",
        "runners.convergence.poolSummary": "{{converged}}/{{connected}} connected Runners · Desired generation {{generation}}",
        "runners.convergence.noConnectedSummary": "Waiting for a Runner to apply desired generation {{generation}}.",
        "runners.convergence.appliedDesired": "Applied {{applied}} · Desired {{desired}}",
        "runners.convergence.lastReported": "Last reported {{applied}} · Desired {{desired}}",
        "runners.convergence.generationsBehind": "Lag: {{count}} generation(s)",
        "runners.convergence.generationMismatch": "Applied and desired generations differ",
        "runners.convergence.runner.converged": "Converged",
        "runners.convergence.runner.syncing": "Syncing",
        "runners.convergence.runner.unavailable": "Not connected",
        "runners.removeAria": "Remove {{runnerId}}",
        "runners.forceRemoveAria": "Force remove {{runnerId}}",
        "runners.forceRemove": "Force remove Runner",
        "runners.forceRemoved": "Runner registration forcibly removed",
        "runners.removal.forceTitle": "Force remove this Runner?",
        "runners.removal.forceWarning": "A running Runner can reconnect and register again; this does not stop its process or delete its Pod.",
        "runners.removal.title": "Remove this offline Runner?",
        "runners.removal.retentionNote": "The Runner pool, Kubernetes workload, runtime events, and audit history remain.",
        "runners.removal.delete": "Remove Runner",
        "runners.removed": "Offline Runner removed",
      };
      return Object.entries(values ?? {}).reduce(
        (label, [name, value]) => label.replace(`{{${name}}}`, value),
        (key.startsWith("runnerView.") ? runnerText(key, values) : labels[key]) ?? key.split(".").at(-1) ?? key,
      );
    },
    i18n: { language: "en", exists: () => false },
  }),
}));

vi.mock("@/components/ui/notifications", () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { role: mocks.role } }),
}));

vi.mock("@/lib/controller-api", () => ({
  ControllerRequestError: class ControllerRequestError extends Error {},
  listRunnerPools: (...args: unknown[]) => mocks.listRunnerPools(...args),
  removeRunnerInstance: (...args: unknown[]) => mocks.removeRunnerInstance(...args),
  updateRunnerPool: (...args: unknown[]) => mocks.updateRunnerPool(...args),
}));

const runnerPool: RunnerPool = {
  id: "default",
  name: "GuardRails 0",
  isDefault: true,
  desiredReplicas: 2,
  safeRpsPerRunner: 50,
  maxConcurrencyPerRunner: 64,
  instances: [
    {
      runnerId: "runner-offline",
      bootId: "boot-offline",
      poolId: "default",
      status: "offline",
      runnerVersion: "0.2.0",
      nemoVersion: "0.24.0",
      compilerCapable: true,
      maxConcurrency: 64,
      desiredGeneration: 2,
      appliedGeneration: 2,
      load: null,
      lastHeartbeatAt: "2026-08-20T10:00:00.000Z",
    },
    {
      runnerId: "runner-ready",
      bootId: "boot-ready",
      poolId: "default",
      status: "ready",
      runnerVersion: "0.2.0",
      nemoVersion: "0.24.0",
      compilerCapable: true,
      maxConcurrency: 64,
      desiredGeneration: 2,
      appliedGeneration: 2,
      load: null,
      lastHeartbeatAt: "2026-08-20T10:01:00.000Z",
    },
  ],
  capacity: {
    readyRunners: 1,
    totalRunners: 2,
    currentRps: 0,
    safeRpsCapacity: 50,
    utilization: 0,
    inflightUtilization: 0,
    cpuUtilization: 0,
    memoryUtilization: 0,
    queueDepth: 0,
    errorRate: 0,
    latencyP95Ms: 0,
    worstRunnerLatencyP95Ms: 0,
    recommendedReplicas: 1,
    headroomRps: 50,
  },
};


function runnerText(key: string, values?: Record<string, string | number>) {
  const path = key.replace("runnerView.", "");
  const plural = values?.count !== undefined ? `${path}_${values.count === 1 ? "one" : "other"}` : path;
  const dictionary = runnerViewEn as unknown as Record<string, unknown>;
  return (dictionary[plural] ?? path.split(".").reduce<unknown>((object, part) => (object as Record<string, unknown>)?.[part], dictionary)) as string;
}
const clients: QueryClient[] = [];
function renderPage(showHeader = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><RunnerCapacitySection showHeader={showHeader} /></QueryClientProvider>);
  return client;
}
async function expand(id: string) {
  fireEvent.click(await screen.findByRole("button", { name: id, exact: true }));
}
async function editCapacity() {
  await screen.findByRole("button", { name: "runner-ready", exact: true });
  fireEvent.click(screen.getByRole("button", { name: "planningTitle" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit capacity targets" }));
}

beforeEach(() => {
  mocks.role = "admin";
  mocks.listRunnerPools.mockReset().mockResolvedValue({ items: [runnerPool] });
  mocks.removeRunnerInstance.mockReset().mockResolvedValue(undefined);
  mocks.updateRunnerPool.mockReset().mockResolvedValue(runnerPool);
  mocks.toastSuccess.mockReset();
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

describe("Runner fleet overview and details", () => {
  it("prioritizes serving count and instance rows, with technical details collapsed", async () => {
    renderPage(false);
    expect(await screen.findByRole("heading", { name: "1 Runner serving" })).toBeTruthy();
    expect(screen.getByText("1 registered Runner is offline. All connected Runners have applied their current configuration.")).toBeTruthy();
    expect(screen.getByText("Capacity target: 2 Runners")).toBeTruthy();
    expect(screen.getByText(/1 currently serving/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "runner-ready" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("NeMo version")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Runner capacity" })).toBeNull();
    await expand("runner-ready");
    expect(screen.getByRole("button", { name: "runner-ready" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("0.24.0")).toBeTruthy();
    expect(screen.getByText("Applied / current configuration version")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Remove runner-ready/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "runner-ready" }));
    expect(screen.queryByText("NeMo version")).toBeNull();
  });

  it("shows pending configuration separately from an offline registration", async () => {
    mocks.listRunnerPools.mockResolvedValue({ items: [{ ...runnerPool, capacity: { ...runnerPool.capacity, readyRunners: 0 }, instances: [runnerPool.instances[0], { ...runnerPool.instances[1], status: "syncing", appliedGeneration: 1 }] }] });
    renderPage();
    expect(await screen.findByRole("heading", { name: "1 Runner updating configuration" })).toBeTruthy();
    expect(screen.getByText("1 registered Runner is offline. 1 connected Runner has not applied its current configuration yet.")).toBeTruthy();
    expect(screen.getByText("Applied 1 · Current 2")).toBeTruthy();
    expect(screen.getByText("Not confirmed")).toBeTruthy();
    expect(screen.getByText("Last reported version 2")).toBeTruthy();
  });

  it("does not present an offline Runner's previous load as current measurements", async () => {
    mocks.listRunnerPools.mockResolvedValue({ items: [{ ...runnerPool, capacity: { ...runnerPool.capacity, readyRunners: 0 }, instances: [{ ...runnerPool.instances[0], load: { inflight: 42, queueDepth: 17, cpuUtilization: 0.9, memoryUtilization: 0.8 } }] }] });
    renderPage();
    expect(await screen.findByRole("heading", { name: "No Runners serving" })).toBeTruthy();
    const row = screen.getByRole("row", { name: /runner-offline/ });
    expect(within(row).queryByText("42 / 17")).toBeNull();
    await expand("runner-offline");
    expect(screen.queryByText("90% / 80%")).toBeNull();
    expect(screen.getByText(/last reported version does not confirm/)).toBeTruthy();
  });

  it("shows registration guidance when a pool has no instances", async () => {
    mocks.listRunnerPools.mockResolvedValue({ items: [{ ...runnerPool, instances: [], capacity: { ...runnerPool.capacity, readyRunners: 0, totalRunners: 0 } }] });
    renderPage();
    expect(await screen.findByRole("heading", { name: "No Runners registered" })).toBeTruthy();
    expect(screen.getAllByText("Waiting for a Runner to register with the Controller.")).toHaveLength(2);
    expect(screen.queryByText("All connected Runners have applied their current configuration.")).toBeNull();
  });

  it("shows a retrieval failure and recovers through retry", async () => {
    mocks.listRunnerPools.mockRejectedValueOnce(new Error("Connection unavailable"));
    renderPage();
    expect(await screen.findByRole("heading", { name: "Unable to load Runner status" })).toBeTruthy();
    expect(screen.queryByText("1 Runner serving")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(await screen.findByRole("heading", { name: "1 Runner serving" })).toBeTruthy();
  });

  it("replaces stale serving claims after a background refresh fails", async () => {
    const client = renderPage();
    await screen.findByRole("heading", { name: "1 Runner serving" });
    mocks.listRunnerPools.mockRejectedValue(new Error("Connection unavailable"));
    await act(async () => { await client.invalidateQueries({ queryKey: ["resources", "runner-pools"] }); });
    expect(await screen.findByRole("heading", { name: "Unable to load Runner status" })).toBeTruthy();
    expect(screen.queryByText("1 Runner serving")).toBeNull();
    expect(screen.queryByRole("button", { name: "runner-offline" })).toBeNull();
  });
});

describe("Runner capacity planning", () => {
  it("opens planning on demand and saves the same capacity contract", async () => {
    renderPage();
    await editCapacity();
    expect(screen.getByText(/Changing them does not start or stop Runners/)).toBeTruthy();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Desired Runners" }), { target: { value: "3" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "safeRpsPerRunner" }), { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save targets" }));
    await waitFor(() => expect(mocks.updateRunnerPool).toHaveBeenCalledWith("default", { desiredReplicas: 3, safeRpsPerRunner: 12.5, maxConcurrencyPerRunner: 64 }));
    await waitFor(() => expect(screen.queryByRole("spinbutton", { name: "Desired Runners" })).toBeNull());
  });

  it("validates the default group's minimum target and preserves inputs on save failure", async () => {
    mocks.updateRunnerPool.mockRejectedValue(new Error("Capacity update failed"));
    renderPage();
    await editCapacity();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Desired Runners" }), { target: { value: "1" } });
    expect((screen.getByRole("button", { name: "Save targets" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Desired Runners" }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save targets" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Capacity update failed");
    expect((screen.getByRole("spinbutton", { name: "Desired Runners" }) as HTMLInputElement).value).toBe("3");
    mocks.updateRunnerPool.mockResolvedValue(runnerPool);
    fireEvent.click(screen.getByRole("button", { name: "Save targets" }));
    await waitFor(() => expect(screen.queryByRole("spinbutton")).toBeNull());
  });

  it("allows non-admins to inspect planning without changing targets", async () => {
    mocks.role = "member";
    renderPage();
    await screen.findByRole("button", { name: "runner-ready" });
    fireEvent.click(screen.getByRole("button", { name: "planningTitle" }));
    expect(screen.getByText("Recommended Runners")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit capacity targets" })).toBeNull();
  });
});

describe("Runner removal permissions and recovery", () => {
  it("offers offline removal in expanded details and preserves its confirmation", async () => {
    renderPage();
    expect(screen.queryByRole("button", { name: "Remove runner-offline" })).toBeNull();
    await expand("runner-offline");
    fireEvent.click(screen.getByRole("button", { name: "Remove runner-offline" }));
    expect(screen.getByText("Remove this offline Runner?")).toBeTruthy();
    expect(screen.getByText(/runtime events, and audit history remain/)).toBeTruthy();
    expect(mocks.removeRunnerInstance).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove Runner" }));
    await waitFor(() => expect(mocks.removeRunnerInstance).toHaveBeenCalledWith("runner-offline"));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Offline Runner removed"));
  });

  it.each([0, 1])("preserves force removal with boot identity during syncing (applied=%s)", async appliedGeneration => {
    mocks.listRunnerPools.mockResolvedValue({ items: [{ ...runnerPool, instances: [{ ...runnerPool.instances[1], status: "syncing", appliedGeneration }] }] });
    renderPage();
    await expand("runner-ready");
    fireEvent.click(screen.getByRole("button", { name: "Force remove runner-ready" }));
    expect(screen.getByText("Force remove this Runner?")).toBeTruthy();
    expect(screen.getByText(/does not stop its process or delete its Pod/)).toBeTruthy();
    expect(mocks.removeRunnerInstance).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Force remove Runner" }));
    await waitFor(() => expect(mocks.removeRunnerInstance).toHaveBeenCalledWith("runner-ready", { force: true, bootId: "boot-ready" }));
  });

  it.each(["offline", "syncing"] as const)("does not expose %s removal to non-admins", async status => {
    mocks.role = "member";
    mocks.listRunnerPools.mockResolvedValue({ items: [{ ...runnerPool, instances: [{ ...runnerPool.instances[1], status }] }] });
    renderPage();
    await expand("runner-ready");
    expect(screen.queryByRole("button", { name: /Remove runner-|Force remove runner-/ })).toBeNull();
  });

  it("keeps the removal confirmation open when the Runner reconnects", async () => {
    mocks.removeRunnerInstance.mockRejectedValue(new Error("Only an offline Runner registration can be removed."));
    renderPage();
    await expand("runner-offline");
    fireEvent.click(screen.getByRole("button", { name: "Remove runner-offline" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Runner" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Only an offline Runner registration can be removed.");
    expect(screen.getByText("Remove this offline Runner?")).toBeTruthy();
  });
});
