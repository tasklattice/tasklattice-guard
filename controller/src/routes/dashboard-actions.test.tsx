import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./dashboard";
import { assembleMetrics } from "../../server/services/runtime-metric-results";
import type { Metrics } from "@/lib/api";
import { dashboardInvestigationEn } from "@/dashboard-investigation-i18n";
import { runtimeMetricsEn } from "@/runtime-metrics-i18n";

const state = vi.hoisted(() => ({ metrics: undefined as Metrics | undefined }));
vi.mock("@/features/dashboard", () => ({ useGuardrailsDashboard: () => ({ metrics: { data: state.metrics, isLoading: false }, events: { data: { items: [] }, isLoading: false }, guardrails: { data: { items: [] } } }) }));
vi.mock("@/components/dashboard/runtime-metric-chart", () => ({ RuntimeMetricChart: () => <div>Runtime chart</div> }));
vi.mock("@/components/dashboard/runtime-event-stream", () => ({ RuntimeEventStream: () => null }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, to, search }: { children: ReactNode; to: string; search?: Record<string, string> }) => <a href={`${to}${search ? `?${new URLSearchParams(Object.entries(search).filter(([, value]) => value !== undefined))}` : ""}`}>{children}</a> }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (key: string, values: Record<string, unknown> = {}) => {
    const labels: Record<string, string> = { "dashboard.p95Latency": "P95 latency", "dashboard.errorRate": "Error rate", "dashboard.protectedTraffic": "Protected traffic", "dashboard.interventionRate": "Intervention rate", "dashboard.metrics.p95_latency": "P95 latency", "dashboard.metrics.error_rate": "Error rate" };
    const resource = key.startsWith("dashboardInvestigation.") ? dashboardInvestigationEn : key.startsWith("runtimeMetrics.") ? runtimeMetricsEn : null;
    const value = resource ? key.split(".").slice(1).reduce<unknown>((part, field) => (part as Record<string, unknown>)?.[field], resource) : labels[key];
    return Object.entries(values).reduce((text, [name, replacement]) => text.replaceAll(`{{${name}}}`, String(replacement)), typeof value === "string" ? value : key);
  }, i18n: { language: "en" },
}) }));

const baseline = (): Metrics => ({ ...assembleMetrics({ window: "7d" }, Date.parse("2026-11-03T01:00:00Z"), 3_600_000, "1h", [], [], [], [], [], []),
  total_decisions: 1000, runtime_p95_ms: 6210, error_rate: 5.4, errors: 54, intervention_rate: 70,
  scope: { guardrail_id: "guardrail-a", guardrail_name: "Finance Guardrail" },
});
beforeEach(() => { state.metrics = baseline(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Dashboard administrator investigation", () => {
  it("highlights latency and errors and gives both an explicit action", () => {
    render(<DashboardPage />);
    expect(screen.getByRole("region", { name: "P95 latency" }).getAttribute("data-attention")).toBe("critical");
    expect(screen.getByRole("region", { name: "Error rate" }).getAttribute("data-attention")).toBe("warning");
    expect(screen.getByRole("region", { name: "Protected traffic" }).hasAttribute("data-attention")).toBe(false);
    expect(within(screen.getByRole("region", { name: "Intervention rate" })).queryByRole("button", { name: /Contact administrator/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Contact administrator about P95 latency" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Contact administrator about Error rate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Elevated error rate.*Contact administrator/ })).toBeTruthy();
  });
  it("keeps the report snapshot stable and copies the scoped time range", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { rerender } = render(<DashboardPage />);
    fireEvent.click(screen.getByRole("button", { name: "Contact administrator about P95 latency" }));
    const summary = screen.getByRole("textbox", { name: "Troubleshooting summary" }) as HTMLTextAreaElement;
    const snapshot = summary.value;
    expect(snapshot).toContain("Finance Guardrail (guardrail-a)");
    expect(snapshot).toContain("6,210 ms");
    const href = screen.getByRole("link", { name: "View related logs" }).getAttribute("href")!;
    const search = new URL(href, "http://localhost").searchParams;
    expect(search.get("guardrailId")).toBe("guardrail-a");
    expect(search.get("since")).toBe("2026-10-27T01:00:00.000Z");
    expect(search.get("until")).toBe("2026-11-03T01:00:00.000Z");
    expect(search.has("outcome")).toBe(false);
    state.metrics = { ...state.metrics!, runtime_p95_ms: 100 };
    rerender(<DashboardPage />);
    expect(summary.value).toBe(snapshot);
    fireEvent.click(screen.getByRole("button", { name: "Copy summary" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(snapshot));
    expect(await screen.findByText("Copied — share with your administrator")).toBeTruthy();
  });
  it("filters error evidence and recovers from clipboard failure", async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error("Clipboard blocked")).mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<DashboardPage />);
    fireEvent.click(screen.getByRole("button", { name: "Contact administrator about Error rate" }));
    const link = screen.getByRole("link", { name: "View related logs" });
    expect(new URL(link.getAttribute("href")!, "http://localhost").searchParams.get("outcome")).toBe("error");
    fireEvent.click(screen.getByRole("button", { name: "Copy summary" }));
    expect(await screen.findByText("Could not copy. Select and copy the summary above manually.")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Troubleshooting summary" }) as HTMLTextAreaElement).readOnly).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Copy summary" }));
    expect(await screen.findByText("Copied — share with your administrator")).toBeTruthy();
  });
  it("does not request escalation for healthy metrics or an empty window", () => {
    state.metrics = { ...baseline(), runtime_p95_ms: 120, error_rate: 0, errors: 0 };
    const { rerender } = render(<DashboardPage />);
    expect(screen.queryByRole("button", { name: /Contact administrator/ })).toBeNull();
    expect(screen.getByText("No attention thresholds reached")).toBeTruthy();
    state.metrics = { ...baseline(), total_decisions: 0 };
    rerender(<DashboardPage />);
    expect(screen.queryByRole("button", { name: /Contact administrator/ })).toBeNull();
    expect(screen.getByText("dashboard.gettingStarted")).toBeTruthy();
  });
  it("also respects a stricter configured latency SLO", () => {
    state.metrics = { ...baseline(), runtime_p95_ms: 200, error_rate: 0, latency_slo: { ...baseline().latency_slo, p95_status: "breached", p95_budget_ms: 100 } };
    render(<DashboardPage />);
    fireEvent.click(screen.getByRole("button", { name: "Contact administrator about P95 latency" }));
    expect((screen.getByRole("textbox", { name: "Troubleshooting summary" }) as HTMLTextAreaElement).value).toContain("Configured P95 SLO exceeded");
  });
});
