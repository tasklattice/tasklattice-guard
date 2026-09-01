import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SystemStatus } from "@/lib/controller-api";

import { RuntimeHealthMenu } from "./layout";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/runners">{children}</a>,
  Outlet: () => null,
  useRouterState: () => "/dashboard",
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ isLoading: false, status: { authenticated: true }, user: { role: "admin" } }),
}));

vi.mock("@/components/control-plane-sidebar", () => ({ ControlPlaneSidebar: () => null }));
vi.mock("@/routes/login", () => ({ LoginPage: () => null }));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => ({
      "runtimeHealth.open": "Open runtime health",
      "runtimeHealth.title": "Runtime health",
      "runtimeHealth.ready": "Runtime ready",
      "runtimeHealth.readyDescription": "Required services are ready.",
      "runtimeHealth.modelConnections": "Model connections",
      "runtimeHealth.controlPlane": "Control Plane",
      "runtimeHealth.dataPlane": "Data Plane",
      "runtimeHealth.policyAnalysis": "Policy analysis",
      "runtimeHealth.contentSafety": "Content safety",
      "runtimeHealth.taxonomyJudge": "TALI taxonomy judge",
      "runtimeHealth.runtimeState": "Runtime state",
      "runtimeHealth.generation": "Desired generation",
      "runtimeHealth.defaultRunner": "GuardRails 0",
      "runtimeHealth.runnerReady": "Ready",
      "runtimeHealth.baselineReady": "Controller and Runner are ready.",
      "runtimeHealth.openRunners": "Open Runner capacity",
    } as Record<string, string>)[key] ?? key,
  }),
}));

const status: SystemStatus = {
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

describe("RuntimeHealthMenu", () => {
  afterEach(cleanup);

  it("shows Runner models as a simple list without capability details", () => {
    render(<RuntimeHealthMenu loading={false} error={null} status={status} />);

    const trigger = screen.getByRole("button", { name: /Qwen · Runner, Runtime ready/ });
    expect(trigger.textContent).toContain("Qwen · Runner");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });

    expect(screen.getByText("Control Plane")).toBeTruthy();
    expect(screen.getByText("Data Plane")).toBeTruthy();
    expect(screen.getByText("Qwen/Qwen3.5-9B")).toBeTruthy();
    expect(screen.getByText("Qwen/Qwen3Guard-Gen-8B")).toBeTruthy();
    expect(screen.getByText("meta-llama/Llama-Guard-3-8B")).toBeTruthy();
    expect(screen.queryByText("Content safety")).toBeNull();
    expect(screen.queryByText("TALI taxonomy judge")).toBeNull();
    expect(screen.getByText("Ready")).toBeTruthy();
  });
});
