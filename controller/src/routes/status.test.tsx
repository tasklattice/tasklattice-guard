import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  "platformStatus.models.title": "Active model configuration",
  "platformStatus.models.description": "Models are optional.",
  "platformStatus.models.controlPlane": "Control Plane",
  "platformStatus.models.dataPlane": "Data Plane",
  "platformStatus.models.authoringNotConfigured": "Authoring is not configured; runtime does not require it.",
  "platformStatus.models.noBindings": "No active Input or Output model bindings.",
  "platformStatus.models.optionalForRelease": "Models are optional for this local release.",
  "platformStatus.models.requiredForRelease": "This release requires data-plane models.",
  "platformStatus.models.dependenciesUnknown": "Model dependencies cannot be fully confirmed.",
  "platformStatus.minimum.modelBackedTitle": "Model-backed protection",
  "platformStatus.minimum.unknownTitle": "Dependencies not fully verified",
  "platformStatus.minimum.emptyTitle": "No protection checks enabled",
  "platformStatus.minimum.input": "Input checks",
  "platformStatus.minimum.output": "Output checks",
  "platformStatus.minimum.policies": "Executing Policies",
  "platformStatus.minimum.draftFailed": "Draft did not pass validation",
  "platformStatus.minimum.draftNotActive": "Draft changes do not affect the published release.",
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
  "platformStatus.defaultRoute": "Catch-all router",
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
          : key === "platformStatus.models.bindingCount" ? `${values?.count} active detector binding(s)`
            : key === "platformStatus.minimum.checks" ? `${values?.count} configured`
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
      routerStatus: "active",
      activeVersion: "20260904-093000.000Z",
      modelIndependent: true,
      coverage: { policyCount: 3, inputChecks: 3, outputChecks: 2, requiredModelBindings: [], hasUnknownDependencies: false },
      draft: { revision: 1, activeRevision: 1, validationStatus: "passed", validationFailureReason: null },
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
      status: "configured",
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
    expect(screen.getByText("Active model configuration")).toBeTruthy();
    expect(screen.getByText("3 configured")).toBeTruthy();
    expect(screen.getByText("2 configured")).toBeTruthy();
    expect(screen.getByText("2 active detector binding(s)")).toBeTruthy();
    expect(screen.getAllByText("Configured")).toHaveLength(2);
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
    expect(screen.getByText("Models are optional for this local release.")).toBeTruthy();
    expect(screen.getByText("No active Input or Output model bindings.")).toBeTruthy();
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
          routerStatus: "initializing",
          activeVersion: null,
        },
        runnerFleet: {
          ...readyStatus.components.runnerFleet,
          status: "initializing",
          servingRunners: 0,
          convergedRunners: 0,
        },
        runtimeModels: { ...readyStatus.components.runtimeModels, status: "configured" },
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

  it("does not call a customized model-dependent release model-free or optional", async () => {
    vi.mocked(getControllerSystemStatus).mockResolvedValue({ ...readyStatus, components: { ...readyStatus.components,
      basicProtection: { ...readyStatus.components.basicProtection, modelIndependent: false,
        coverage: { ...readyStatus.components.basicProtection.coverage!, requiredModelBindings: ["content_safety.output"] } },
    } });
    renderPage();
    expect(await screen.findByText("Model-backed protection")).toBeTruthy();
    expect(screen.getByText("This release requires data-plane models.")).toBeTruthy();
    expect(screen.queryByText("Local, model-free Policies")).toBeNull();
    expect(screen.queryByText("Models are optional for this local release.")).toBeNull();
  });

  it("separates an unsuccessful newer draft from the serving published release", async () => {
    vi.mocked(getControllerSystemStatus).mockResolvedValue({ ...readyStatus, components: { ...readyStatus.components,
      basicProtection: { ...readyStatus.components.basicProtection,
        draft: { revision: 2, activeRevision: 1, validationStatus: "failed", validationFailureReason: "Probe failed" } },
    } });
    renderPage();
    expect(await screen.findByText("Basic protection is available")).toBeTruthy();
    expect(screen.getByText("Draft did not pass validation")).toBeTruthy();
    expect(screen.getByText("Draft changes do not affect the published release.")).toBeTruthy();
  });

  it("does not present missing published evidence as zero dependencies", async () => {
    vi.mocked(getControllerSystemStatus).mockResolvedValue({ ...readyStatus, status: "unavailable", components: { ...readyStatus.components,
      basicProtection: { ...readyStatus.components.basicProtection, status: "unavailable", modelIndependent: null, coverage: null },
    } });
    renderPage();
    expect(await screen.findByText("Dependencies not fully verified")).toBeTruthy();
    expect(screen.getByText("Model dependencies cannot be fully confirmed.")).toBeTruthy();
    expect(screen.queryByText("Local, model-free Policies")).toBeNull();
  });

  it("recovers from a failed refresh without keeping a stale green result", async () => {
    vi.mocked(getControllerSystemStatus).mockResolvedValueOnce(readyStatus)
      .mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(readyStatus);
    renderPage();
    await screen.findByText("Basic protection is available");
    fireEvent.click(screen.getByRole("button", { name: "Refresh health" }));
    await screen.findByText("Basic protection cannot be confirmed");
    expect(screen.queryByText("Basic protection is available")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh health" }));
    await screen.findByText("Basic protection is available");
    await waitFor(() => expect(getControllerSystemStatus).toHaveBeenCalledTimes(3));
  });
});
