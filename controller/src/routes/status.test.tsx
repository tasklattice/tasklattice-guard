import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getControllerSystemStatus, type SystemStatus } from "@/lib/controller-api";

import { HealthPage } from "./status";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) => select({ location: { pathname: "/settings/health" } }),
}));

vi.mock("@/lib/controller-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/controller-api")>();
  return { ...original, getControllerSystemStatus: vi.fn() };
});

const translations: Record<string, string> = {
  "platformStatus.title": "Health",
  "platformStatus.description": "Confirm minimum protection.",
  "platformStatus.refresh": "Refresh health",
  "platformStatus.refreshing": "Refreshing health…",
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
  "platformStatus.state.active": "Active",
  "platformStatus.basic.eyebrow": "Minimum usable level",
  "platformStatus.basic.ready": "Basic protection is available",
  "platformStatus.basic.readyDescription": "The local baseline is available.",
  "platformStatus.basic.initializing": "Basic protection is starting",
  "platformStatus.basic.initializingDescription": "The baseline is starting.",
  "platformStatus.basic.unavailable": "Basic protection is unavailable",
  "platformStatus.basic.unavailableDescription": "The baseline is unavailable.",
  "platformStatus.basic.unknown": "Basic protection cannot be confirmed",
  "platformStatus.basic.unknownDescription": "Live status is unavailable.",
  "platformStatus.minimum.title": "Minimum protection path",
  "platformStatus.minimum.description": "Required runtime resources.",
  "platformStatus.minimum.modelFreeTitle": "Local, model-free Policies",
  "platformStatus.minimum.modelFreeDescription": "No external model is called.",
  "platformStatus.minimum.openDefault": "Inspect Default Guardrail",
  "platformStatus.models.title": "Optional model coverage",
  "platformStatus.models.description": "Models are optional.",
  "platformStatus.models.controlPlane": "Control Plane",
  "platformStatus.models.dataPlane": "Data Plane",
  "platformStatus.models.notConfiguredDetail": "Not configured · not required for the local baseline",
  "platformStatus.models.configure": "Configure models",
  "platformStatus.models.assign": "Assign capabilities",
  "platformStatus.attention": "What needs attention",
  "platformStatus.reason.runner_configuration_syncing": "A Runner is applying the desired generation.",
  "platformStatus.reason.runner_capacity_below_desired": "Serving capacity is below desired.",
  "platformStatus.reason.runner_saturated": "A Runner is saturated.",
  "platformStatus.reason.runner_errors": "Runner errors crossed the threshold.",
  "platformStatus.reason.no_serving_runners": "No Runner can serve traffic.",
  "platformStatus.reason.no_connected_runners": "No Runner is connected.",
  "platformStatus.reason.default_guardrail_initializing": "The Default Guardrail is being prepared.",
  "platformStatus.reason.default_guardrail_unavailable": "The Default Guardrail is unavailable.",
  "platformStatus.controller": "Controller",
  "platformStatus.defaultGuardrail": "Default Guardrail",
  "platformStatus.defaultRoute": "Catch-all deployment",
  "platformStatus.defaultRunner": "GuardRails 0",
  "platformStatus.desiredGeneration": "Desired generation",
  "platformStatus.statusUnavailable": "Live status is unavailable",
  "platformStatus.statusUnavailableDescription": "Retry when the Controller responds.",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { time?: string; version?: string; count?: number }) => key === "platformStatus.lastChecked"
      ? `Last checked ${values?.time}`
      : key === "platformStatus.activeVersion" ? `Active · ${values?.version}`
        : key === "platformStatus.servingRunners" ? `${values?.count} serving`
          : key === "platformStatus.models.modelCount" ? `${values?.count} runtime model(s) configured`
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
    basicProtection: {
      status: "ready",
      guardrailStatus: "active",
      deploymentStatus: "active",
      activeVersion: "20260904-093000.000Z",
      modelIndependent: true,
    },
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
  return render(<QueryClientProvider client={client}><HealthPage /></QueryClientProvider>);
}

describe("HealthPage", () => {
  beforeEach(() => vi.mocked(getControllerSystemStatus).mockReset());
  afterEach(() => {
    cleanup();
    client?.clear();
    client = null;
  });

  it("shows the verified minimum protection path and keeps model coverage separate", async () => {
    vi.mocked(getControllerSystemStatus).mockResolvedValue(readyStatus);
    renderPage();

    expect(await screen.findByText("Basic protection is available")).toBeTruthy();
    expect(screen.getByText("Operational")).toBeTruthy();
    expect(screen.getByText("Active · 20260904-093000.000Z")).toBeTruthy();
    expect(screen.getByText("2 serving")).toBeTruthy();
    expect(screen.getByText("Optional model coverage")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Health", level: 1 })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Runner capacity" })).toBeNull();
    expect(screen.getByText("Qwen/Qwen3.5-9B")).toBeTruthy();
  });

  it("keeps basic protection ready when optional models are not configured", async () => {
    vi.mocked(getControllerSystemStatus).mockResolvedValue({
      ...readyStatus,
      components: {
        ...readyStatus.components,
        controlPlaneModel: { status: "unconfigured", provider: null, model: null },
        runtimeModels: { status: "unconfigured", provider: "Runner", models: [] },
      },
    });
    renderPage();

    expect(await screen.findByText("Basic protection is available")).toBeTruthy();
    expect(screen.getAllByText("Not configured")).toHaveLength(2);
    expect(screen.getAllByText("Not configured · not required for the local baseline")).toHaveLength(2);
  });

  it("explains initialization while connected Runners are still converging", async () => {
    vi.mocked(getControllerSystemStatus).mockResolvedValue({
      ...readyStatus,
      status: "initializing",
      reasons: ["runner_configuration_syncing"],
      components: {
        ...readyStatus.components,
        basicProtection: {
          ...readyStatus.components.basicProtection,
          status: "initializing",
          guardrailStatus: "initializing",
          deploymentStatus: "initializing",
          activeVersion: null,
        },
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

    expect(await screen.findByText("Basic protection is starting")).toBeTruthy();
    expect(screen.getByText(/A Runner is applying the desired generation\./)).toBeTruthy();
    expect(screen.getAllByText("Initializing").length).toBeGreaterThan(0);
  });

  it("treats a missing status response as unknown and keeps recovery visible", async () => {
    vi.mocked(getControllerSystemStatus).mockResolvedValue(undefined as unknown as SystemStatus);
    renderPage();

    expect(await screen.findByText("Basic protection cannot be confirmed")).toBeTruthy();
    expect(screen.getByText("Live status is unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh health" })).toBeTruthy();
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(1);
  });
});
