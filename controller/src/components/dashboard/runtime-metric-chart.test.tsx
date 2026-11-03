import { type ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Metrics } from "@/lib/api";
import { RuntimeMetricChart } from "./runtime-metric-chart";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactElement }) => <a href="/integration/routers">{children}</a> }));
vi.mock("./runtime-metric-plot", () => ({ default: ({ visible }: { visible: string[] }) => <div data-testid="runtime-plot" data-visible={visible.join(",")} /> }));
const metrics = { total_decisions: 120, window: "1h", interval: "1m", window_start: "2026-11-03T00:00:00Z", trend: [0, 1, 2].map(minute => ({ timestamp: `2026-11-03T00:0${minute}:00Z`, total: 40, allowed: 30, blocked: 4, transformed: 2, errored: 4, timed_out: 1, p50_latency_ms: 100, p95_latency_ms: 450, p99_latency_ms: 900 })) } as Metrics;
afterEach(cleanup);
describe("RuntimeMetricChart", () => {
  it("draws QPS, errors and latency together, and toggles individual series", async () => {
    render(<RuntimeMetricChart metrics={metrics} />);
    await waitFor(() => expect(screen.getByTestId("runtime-plot").getAttribute("data-visible")).toBe("request_rate,error_rate,p95_latency"));
    const qps = screen.getByRole("button", { name: "runtimeMetrics.qps" });
    const errors = screen.getByRole("button", { name: "dashboard.metrics.error_rate" });
    const latency = screen.getByRole("button", { name: "dashboard.metrics.p95_latency" });
    for (const button of [qps, errors, latency]) expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "dashboard.metrics.intervention_rate" }));
    expect(screen.getByTestId("runtime-plot").getAttribute("data-visible")).toBe("request_rate,error_rate,p95_latency,intervention_rate");
    fireEvent.click(latency);
    expect(qps.getAttribute("aria-pressed")).toBe("true");
    expect(errors.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("runtime-plot").getAttribute("data-visible")).toBe("request_rate,error_rate,intervention_rate");
  });
  it("honors deep links, preserves series on refresh and keeps one visible", () => {
    const { rerender } = render(<RuntimeMetricChart metrics={metrics} metric="timeout_rate" />);
    expect(screen.getByRole("button", { name: "dashboard.metrics.timeout_rate" }).getAttribute("aria-pressed")).toBe("true");
    for (const name of ["dashboard.metrics.p95_latency", "dashboard.metrics.timeout_rate", "runtimeMetrics.qps"]) fireEvent.click(screen.getByRole("button", { name }));
    const errors = screen.getByRole("button", { name: "dashboard.metrics.error_rate" });
    expect(errors.hasAttribute("disabled")).toBe(true);
    rerender(<RuntimeMetricChart metrics={{ ...metrics }} metric="timeout_rate" />);
    expect(errors.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "runtimeMetrics.qps" }).getAttribute("aria-pressed")).toBe("false");
  });
  it("keeps an honest empty state", () => {
    render(<RuntimeMetricChart metrics={{ ...metrics, total_decisions: 0, trend: [] }} />);
    expect(screen.getByText("dashboard.noTrafficTitle")).toBeTruthy();
    expect(screen.queryByTestId("runtime-plot")).toBeNull();
  });
});
