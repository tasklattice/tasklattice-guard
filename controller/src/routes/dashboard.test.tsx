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
      : path === "/api/v1/system/status" ? { status: "healthy", reasons: [] }
        : { items: [], count: 0 },
  )));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    render(<QueryClientProvider client={client}><DashboardPage /></QueryClientProvider>);
    expect(await screen.findByText(/Runtime metrics are unavailable or incomplete/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "dashboard.title" })).toBeTruthy();
    expect(screen.queryByText("dashboard.protectedTraffic")).toBeNull();
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
