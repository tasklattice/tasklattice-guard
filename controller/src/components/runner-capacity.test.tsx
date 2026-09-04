import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunnerPool } from "@/lib/controller-api";

import { RunnerCapacitySection } from "./runner-capacity";

const mocks = vi.hoisted(() => ({
  listRunnerPools: vi.fn(),
  removeRunnerInstance: vi.fn(),
  role: "admin",
  toastSuccess: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const labels: Record<string, string> = {
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
        "runners.removal.title": "Remove this offline Runner?",
        "runners.removal.retentionNote": "The Runner pool, Kubernetes workload, runtime events, and audit history remain.",
        "runners.removal.delete": "Remove Runner",
        "runners.removed": "Offline Runner removed",
      };
      return Object.entries(values ?? {}).reduce(
        (label, [name, value]) => label.replace(`{{${name}}}`, value),
        labels[key] ?? key.split(".").at(-1) ?? key,
      );
    },
    i18n: { language: "en", exists: () => false },
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { role: mocks.role } }),
}));

vi.mock("@/lib/controller-api", () => ({
  listRunnerPools: (...args: unknown[]) => mocks.listRunnerPools(...args),
  removeRunnerInstance: (...args: unknown[]) => mocks.removeRunnerInstance(...args),
  updateRunnerPool: vi.fn(),
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
    recommendedReplicas: 1,
    headroomRps: 50,
  },
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}><RunnerCapacitySection /></QueryClientProvider>);
}

describe("Runner capacity removal", () => {
  beforeEach(() => {
    mocks.role = "admin";
    mocks.listRunnerPools.mockReset().mockResolvedValue({ items: [runnerPool] });
    mocks.removeRunnerInstance.mockReset().mockResolvedValue(undefined);
    mocks.toastSuccess.mockReset();
  });

  afterEach(cleanup);

  it("offers removal only for an offline Runner and confirms it in the shared side Sheet", async () => {
    renderPage();

    const [removeOffline] = await screen.findAllByRole("button", { name: "Remove runner-offline" });
    expect(screen.queryByRole("button", { name: "Remove runner-ready" })).toBeNull();

    fireEvent.click(removeOffline);
    expect(screen.getByText("Remove this offline Runner?")).toBeTruthy();
    expect(screen.getByText(/runtime events, and audit history remain/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove Runner" }));

    await waitFor(() => expect(mocks.removeRunnerInstance).toHaveBeenCalledWith("runner-offline"));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Offline Runner removed"));
  });

  it("does not expose removal controls to a non-administrator", async () => {
    mocks.role = "member";
    renderPage();

    expect((await screen.findAllByText("runner-offline")).length).toBe(2);
    expect(screen.queryByRole("button", { name: /Remove runner-/ })).toBeNull();
  });

  it("keeps the Sheet open and shows a reconnect conflict", async () => {
    mocks.removeRunnerInstance.mockRejectedValue(new Error("Only an offline Runner registration can be removed."));
    renderPage();

    fireEvent.click((await screen.findAllByRole("button", { name: "Remove runner-offline" }))[0]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Runner" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Only an offline Runner registration can be removed.");
    expect(screen.getByText("Remove this offline Runner?")).toBeTruthy();
  });
});

describe("Runner configuration convergence", () => {
  beforeEach(() => {
    mocks.role = "admin";
    mocks.listRunnerPools.mockReset().mockResolvedValue({ items: [runnerPool] });
    mocks.removeRunnerInstance.mockReset().mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("summarizes convergence across connected Runners and separates an offline registration", async () => {
    renderPage();

    const summary = await screen.findByRole("status");
    expect(summary.textContent).toContain("Configuration converged");
    expect(summary.textContent).toContain("1/1 connected Runners · Desired generation 2");
    expect(screen.getAllByText("Converged")).toHaveLength(2);
    expect(screen.getAllByText("Applied 2 · Desired 2")).toHaveLength(2);
    expect(screen.getAllByText("Not connected")).toHaveLength(2);
    expect(screen.getAllByText("Last reported 2 · Desired 2")).toHaveLength(2);
  });

  it("shows the pool and Runner as syncing with the generation lag", async () => {
    mocks.listRunnerPools.mockResolvedValue({
      items: [{
        ...runnerPool,
        instances: runnerPool.instances.map((runner) => runner.runnerId === "runner-ready"
          ? { ...runner, status: "syncing" as const, appliedGeneration: 1 }
          : runner),
      }],
    });
    renderPage();

    const summary = await screen.findByRole("status");
    expect(summary.textContent).toContain("Configuration syncing");
    expect(summary.textContent).toContain("0/1 connected Runners · Desired generation 2");
    expect(screen.getAllByText("Syncing")).toHaveLength(2);
    expect(screen.getAllByText("Applied 1 · Desired 2")).toHaveLength(2);
    expect(screen.getAllByText("Lag: 1 generation(s)")).toHaveLength(2);
  });

  it("shows an unavailable convergence state when the pool has no connected Runner", async () => {
    mocks.listRunnerPools.mockResolvedValue({
      items: [{ ...runnerPool, instances: runnerPool.instances.filter((runner) => runner.status === "offline") }],
    });
    renderPage();

    const summary = await screen.findByRole("status");
    expect(summary.textContent).toContain("No connected Runners");
    expect(summary.textContent).toContain("Waiting for a Runner to apply desired generation 2.");
  });
});
