import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getControllerSystemStatus, type SystemStatus } from "@/lib/controller-api";

import { StatusPage } from "./status";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) => select({ location: { pathname: "/settings/status" } }),
}));

vi.mock("@/components/runner-capacity", () => ({
  runnerPoolKey: ["resources", "runner-pools"],
  RunnerCapacitySection: () => <section aria-label="Runner capacity">Runner fleet details</section>,
}));

vi.mock("@/lib/controller-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/controller-api")>();
  return { ...original, getControllerSystemStatus: vi.fn() };
});

const translations: Record<string, string> = {
  "platformStatus.title": "Platform status",
  "platformStatus.description": "Monitor platform readiness.",
  "platformStatus.refresh": "Refresh status",
  "platformStatus.refreshing": "Refreshing…",
  "platformStatus.overall.healthy": "Platform services are ready",
  "platformStatus.overall.healthyDescription": "Controller and Runner are ready.",
  "platformStatus.overall.initializing": "Platform runtime is initializing",
  "platformStatus.overall.initializingDescription": "Runners are applying configuration.",
  "platformStatus.overall.degraded": "Platform services need attention",
  "platformStatus.overall.degradedDescription": "Runtime capacity needs attention.",
  "platformStatus.overall.unavailable": "Platform runtime is unavailable",
  "platformStatus.overall.unavailableDescription": "No Runner can serve traffic.",
  "platformStatus.overall.unknown": "Platform status is unknown",
  "platformStatus.overall.unknownDescription": "Live status cannot be confirmed.",
  "platformStatus.state.healthy": "Healthy",
  "platformStatus.state.initializing": "Initializing",
  "platformStatus.state.degraded": "Degraded",
  "platformStatus.state.unknown": "Unknown",
  "platformStatus.state.operational": "Operational",
  "platformStatus.state.ready": "Ready",
  "platformStatus.state.unavailable": "Unavailable",
  "platformStatus.state.configured": "Configured",
  "platformStatus.state.unconfigured": "Not configured",
  "platformStatus.reason.runner_configuration_syncing": "A Runner is applying the desired generation.",
  "platformStatus.reason.runner_capacity_below_desired": "Serving capacity is below desired.",
  "platformStatus.reason.runner_saturated": "A Runner is saturated.",
  "platformStatus.reason.runner_errors": "Runner errors crossed the threshold.",
  "platformStatus.reason.no_serving_runners": "No Runner can serve traffic.",
  "platformStatus.reason.no_connected_runners": "No Runner is connected.",
  "platformStatus.controller": "Controller",
  "platformStatus.defaultRunner": "GuardRails 0",
  "platformStatus.desiredGeneration": "Desired generation",
  "platformStatus.statusUnavailable": "Live status is unavailable",
  "platformStatus.statusUnavailableDescription": "Retry when the Controller responds.",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { time?: string }) => key === "platformStatus.lastChecked"
      ? `Last checked ${values?.time}`
      : translations[key] ?? key,
    i18n: { language: "en" },
  }),
}));

const readyStatus: SystemStatus = {
  status: "healthy",
  reasons: ["all_required_components_ready"],
  observedAt: "2026-09-04T09:30:00.000Z",
  desiredGeneration: 16,
  components: {
    controller: { status: "operational" },
    runnerFleet: {
      status: "healthy",
      servingRunners: 2,
      desiredRunners: 2,
      connectedRunners: 2,
      totalRunners: 2,
      convergedRunners: 2,
      saturatedRunners: 0,
    },
    controlPlaneModel: { status: "configured", provider: "Qwen", model: "Qwen/Qwen3.5-9B" },
    runtimeModels: {
      status: "ready",
      provider: "Runner",
      models: [
        { id: "qwen3guard", model: "Qwen/Qwen3Guard-Gen-8B" },
        { id: "llama-guard", model: "meta-llama/Llama-Guard-3-8B" },
      ],
    },
  },
};

let client: QueryClient | null = null;

function renderPage() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><StatusPage /></QueryClientProvider>);
}

describe("StatusPage", () => {
  beforeEach(() => vi.mocked(getControllerSystemStatus).mockReset());
  afterEach(() => {
    cleanup();
    client?.clear();
    client = null;
  });

  it("shows platform and Runner readiness without duplicating model configuration", async () => {
    vi.mocked(getControllerSystemStatus).mockResolvedValue(readyStatus);
    renderPage();

    expect(await screen.findByText("Platform services are ready")).toBeTruthy();
    expect(screen.getByText("Operational")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Runner capacity" })).toBeTruthy();
    expect(screen.queryByText("Model connections")).toBeNull();
    expect(screen.queryByText("Qwen/Qwen3.5-9B")).toBeNull();
  });

  it("explains initialization while connected Runners are still converging", async () => {
    vi.mocked(getControllerSystemStatus).mockResolvedValue({
      ...readyStatus,
      status: "initializing",
      reasons: ["runner_configuration_syncing"],
      components: {
        ...readyStatus.components,
        runnerFleet: {
          ...readyStatus.components.runnerFleet,
          status: "initializing",
          servingRunners: 0,
          convergedRunners: 0,
        },
        runtimeModels: { ...readyStatus.components.runtimeModels, status: "unavailable" },
      },
    });
    renderPage();

    expect(await screen.findByText("Platform runtime is initializing")).toBeTruthy();
    expect(screen.getByText(/A Runner is applying the desired generation\./)).toBeTruthy();
    expect(screen.getAllByText("Initializing").length).toBeGreaterThan(0);
  });

  it("treats a missing status response as unknown and keeps recovery visible", async () => {
    vi.mocked(getControllerSystemStatus).mockResolvedValue(undefined as unknown as SystemStatus);
    renderPage();

    expect(await screen.findByText("Platform status is unknown")).toBeTruthy();
    expect(screen.getByText("Live status is unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeTruthy();
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(1);
  });
});
