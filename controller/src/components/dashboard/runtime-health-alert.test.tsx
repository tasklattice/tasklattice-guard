import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeHealthAlert, type RuntimeHealthAlertMetrics } from "./runtime-health-alert";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number>) => ({
      "dashboard.degraded": "Degraded",
      "dashboard.healthFailClosed": "Fail-closed decisions were detected.",
      "dashboard.healthLatency": "Runtime latency is elevated.",
      "dashboard.healthEndpoint": `${values?.count ?? 0} endpoints need attention.`,
      "dashboard.healthSystem": "Check platform readiness; missing model capability is not established.",
      "dashboard.platformAttention": "Platform needs attention",
      "platformStatus.reason.runner_capacity_below_desired": "Serving capacity is below the desired replica count.",
      "platformStatus.reason.runner_configuration_syncing": "Runners are applying configuration.",
    }[key] ?? key),
  }),
}));

const healthy: RuntimeHealthAlertMetrics = {
  system_status: "healthy",
  latency_slo: { p95_status: "healthy" },
  fail_closed_count: 0,
  degraded_endpoints: 0,
};

describe("RuntimeHealthAlert", () => {
  afterEach(cleanup);

  it("renders nothing when the runtime is healthy", () => {
    const view = render(<RuntimeHealthAlert metrics={healthy} />);

    expect(view.container.childElementCount).toBe(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("announces the highest-priority runtime anomaly", () => {
    render(<RuntimeHealthAlert metrics={{
      ...healthy,
      system_status: "degraded",
      latency_slo: { p95_status: "breached" },
      fail_closed_count: 2,
      degraded_endpoints: 1,
    }} />);

    expect(screen.getByRole("alert").textContent).toContain("Degraded");
    expect(screen.getByRole("alert").textContent).toContain("Fail-closed decisions were detected.");
    expect(screen.queryByText("Runtime latency is elevated.")).toBeNull();
  });

  it("covers a degraded system without a more specific metric anomaly", () => {
    render(<RuntimeHealthAlert metrics={{ ...healthy, system_status: "degraded" }} />);

    expect(screen.getByRole("alert").textContent).toContain("Check platform readiness");
  });
  it("preserves capacity and convergence reasons without claiming missing model capabilities", () => {
    render(<RuntimeHealthAlert metrics={{ ...healthy, system_status: "degraded", system_reasons: ["runner_capacity_below_desired", "runner_configuration_syncing"] }} />);
    expect(screen.getByRole("alert").textContent).toContain("Platform needs attention");
    expect(screen.getByRole("alert").textContent).toContain("Serving capacity is below");
    expect(screen.getByRole("alert").textContent).toContain("Runners are applying");
    expect(screen.getByRole("alert").textContent).not.toContain("missing model");
  });
});
