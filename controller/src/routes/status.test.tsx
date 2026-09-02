import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getControllerSystemStatus, type SystemStatus } from "@/lib/controller-api";

import { StatusPage } from "./status";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/runners">{children}</a>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) => select({ location: { pathname: "/settings/status" } }),
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
  "platformStatus.overall.unknown": "Platform status is unknown",
  "platformStatus.overall.unknownDescription": "Live status cannot be confirmed.",
  "platformStatus.state.healthy": "Healthy",
  "platformStatus.state.unknown": "Unknown",
  "platformStatus.state.operational": "Operational",
  "platformStatus.state.ready": "Ready",
  "platformStatus.state.configured": "Configured",
  "platformStatus.state.runtimeReady": "Runner ready",
  "platformStatus.components": "Platform components",
  "platformStatus.componentsDescription": "Required services.",
  "platformStatus.controller": "Controller",
  "platformStatus.controllerHealthyDescription": "Status endpoint responded.",
  "platformStatus.controllerUnknownDescription": "Status endpoint unavailable.",
  "platformStatus.defaultRunner": "GuardRails 0",
  "platformStatus.runnerHealthyDescription": "A Runner is ready.",
  "platformStatus.runnerUnknownDescription": "Runner status unavailable.",
  "platformStatus.runtimeState": "Runtime state",
  "platformStatus.desiredGeneration": "Desired generation",
  "platformStatus.refreshInterval": "Automatic refresh",
  "platformStatus.everyFifteenSeconds": "Every 15 seconds",
  "platformStatus.openRunnerCapacity": "Open Runner capacity",
  "platformStatus.modelConnections": "Model connections",
  "platformStatus.modelConnectionsDescription": "Configured models and readiness.",
  "platformStatus.controlPlaneModel": "Control-plane model",
  "platformStatus.policyAnalysis": "Policy analysis",
  "platformStatus.runtimeModels": "Runtime models",
  "platformStatus.readinessEvidence": "Control-plane provider health is not actively probed.",
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
  status: "ready",
  deploymentComplete: true,
  desiredGeneration: 16,
  defaultRunnerReady: true,
  modelConnections: {
    controlPlane: { provider: "Qwen", model: "Qwen/Qwen3.5-9B" },
    dataPlane: {
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

  it("separates Controller availability, configured control-plane models, and Runner-backed model readiness", async () => {
    vi.mocked(getControllerSystemStatus).mockResolvedValue(readyStatus);
    renderPage();

    expect(await screen.findByText("Platform services are ready")).toBeTruthy();
    expect(screen.getByText("Operational")).toBeTruthy();
    expect(screen.getByText("Configured")).toBeTruthy();
    expect(screen.getByText("Runner ready")).toBeTruthy();
    expect(screen.getByText("Qwen/Qwen3.5-9B")).toBeTruthy();
    expect(screen.getByText("Qwen/Qwen3Guard-Gen-8B")).toBeTruthy();
    expect(screen.getByText("meta-llama/Llama-Guard-3-8B")).toBeTruthy();
    expect(screen.getByText(/not actively probed/)).toBeTruthy();
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
