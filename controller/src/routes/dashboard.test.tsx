import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";

import { DashboardPage } from "./dashboard";
import { assembleMetrics } from "../../server/services/runtime-metric-results";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to?: string }) => <a href={to}>{children}</a>,
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps the Dashboard usable after malformed telemetry and recovers on retry", async () => {
  let metrics: unknown = { items: [], count: 0 };
  vi.stubGlobal("fetch", vi.fn(async (path: string) => Response.json(
    path.startsWith("/api/v1/telemetry/metrics") ? metrics
      : path === "/api/v1/system/status" ? { status: "healthy", reasons: [], observedAt: new Date().toISOString() }
        : { items: [], count: 0 },
  )));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    render(<QueryClientProvider client={client}><DashboardPage /></QueryClientProvider>);
    expect(await screen.findByText(/Runtime metrics are unavailable or incomplete/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "dashboard.title" })).toBeTruthy();
    expect(screen.queryByText("dashboard.protectedTraffic")).toBeNull();
    expect(screen.getByText("dashboard.recentEvents")).toBeTruthy();
    metrics = assembleMetrics({ window: "7d" }, Date.parse("2026-10-09T07:00:00Z"), 3_600_000, "1h", [], [], [], [], [], []);
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(await screen.findByText("dashboard.protectedTraffic")).toBeTruthy();
    expect(screen.getByText("dashboard.noTrafficTitle")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Runtime metrics are unavailable or incomplete/)).toBeNull());
    expect(screen.queryByText(/NaN/)).toBeNull();
  } finally {
    client.clear();
  }
});

const completeMetrics = () => assembleMetrics({ window: "7d" }, Date.parse("2026-10-09T07:00:00Z"), 3_600_000, "1h", [], [], [], [], [], []);

it("renders traffic and events while platform status is still pending", async () => {
  vi.stubGlobal("fetch", vi.fn((path: string) => path === "/api/v1/system/status"
    ? new Promise<Response>(() => {})
    : Promise.resolve(Response.json(path.startsWith("/api/v1/telemetry/metrics") ? completeMetrics() : { items: [], count: 0 }))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    render(<QueryClientProvider client={client}><DashboardPage /></QueryClientProvider>);
    expect(await screen.findByText("dashboard.protectedTraffic")).toBeTruthy();
    expect(screen.getByText("dashboard.statusChecking")).toBeTruthy();
    expect(screen.getByText("dashboard.recentEvents")).toBeTruthy();
    const paths = vi.mocked(fetch).mock.calls.map(([path]) => String(path));
    expect(paths).toContain("/api/v1/telemetry/metrics?window=7d&view=overview");
    expect(paths).toContain("/api/v1/guardrails?view=options");
    expect(paths).not.toContain("/api/v1/guardrails");
  } finally { client.clear(); }
});

it("isolates a proxy 503 and retries status without fetching traffic again", async () => {
  let recovered = false;
  const fetch = vi.fn(async (path: string) => path === "/api/v1/system/status"
    ? recovered ? Response.json({ status: "healthy", reasons: [], observedAt: new Date().toISOString() })
      : new Response("Service Unavailable", { status: 503 })
    : Response.json(path.startsWith("/api/v1/telemetry/metrics") ? completeMetrics() : { items: [], count: 0 }));
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    render(<QueryClientProvider client={client}><DashboardPage /></QueryClientProvider>);
    expect(await screen.findByText("dashboard.statusUnavailable")).toBeTruthy();
    expect(await screen.findByText("dashboard.protectedTraffic")).toBeTruthy();
    const metricCalls = () => fetch.mock.calls.filter(([path]) => path.startsWith("/api/v1/telemetry/metrics")).length;
    expect(metricCalls()).toBe(1);
    recovered = true;
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    await waitFor(() => expect(screen.queryByText("dashboard.statusUnavailable")).toBeNull());
    expect(metricCalls()).toBe(1);
  } finally { client.clear(); }
});

it("shows no-connected-runners independently of stalled traffic metrics", async () => {
  vi.stubGlobal("fetch", vi.fn((path: string) => path.startsWith("/api/v1/telemetry/metrics")
    ? new Promise<Response>(() => {})
    : Promise.resolve(path === "/api/v1/system/status"
      ? Response.json({ status: "unavailable", reasons: ["no_connected_runners"], observedAt: new Date().toISOString() }, { status: 503 })
      : Response.json({ items: [], count: 0 }))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    render(<QueryClientProvider client={client}><DashboardPage /></QueryClientProvider>);
    expect(await screen.findByText("platformStatus.reason.no_connected_runners")).toBeTruthy();
    expect(screen.queryByText("dashboard.statusUnavailable")).toBeNull();
    expect(screen.getByText("dashboard.recentEvents")).toBeTruthy();
  } finally { client.clear(); }
});

it("shows event failure without claiming an empty event list or hiding traffic", async () => {
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path.startsWith("/api/v1/telemetry/events")) throw new Error("Event query unavailable");
    return Response.json(path.startsWith("/api/v1/telemetry/metrics") ? completeMetrics()
      : path === "/api/v1/system/status" ? { status: "healthy", reasons: [], observedAt: new Date().toISOString() }
        : { items: [], count: 0 });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    render(<QueryClientProvider client={client}><DashboardPage /></QueryClientProvider>);
    expect(await screen.findByText("Event query unavailable")).toBeTruthy();
    expect(await screen.findByText("dashboard.protectedTraffic")).toBeTruthy();
    expect(screen.queryByText("dashboard.noEventsTitle")).toBeNull();
  } finally { client.clear(); }
});
