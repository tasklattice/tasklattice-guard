import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { componentHealthEn } from "@/component-health-i18n";
import { getControllerSystemHealth, type SystemHealthSnapshot } from "@/lib/controller-api";
import { HealthPage } from "./status";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) => select({ location: { pathname: "/settings/health" } }),
}));
vi.mock("@/lib/controller-api", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/controller-api")>(), getControllerSystemHealth: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({
  i18n: { language: "en" },
  t: (key: string, values: Record<string, string | number> = {}) => {
    const value = key.split(".").slice(1).reduce<unknown>((current, part) => (current as Record<string, unknown>)?.[part], componentHealthEn);
    return typeof value === "string" ? value.replace(/{{(\w+)}}/g, (_, name: string) => String(values[name] ?? "")) : key;
  },
}) }));

const healthy: SystemHealthSnapshot = {
  status: "healthy", observedAt: "2026-10-08T02:00:00Z",
  components: {
    controlPlane: { status: "healthy", reason: "responding" },
    dataPlane: { status: "healthy", reason: "connected", connectedRunners: 2, totalRunners: 2, unresponsiveRunners: 0, heartbeatTimeoutSeconds: 30 },
  },
};
const unhealthy: SystemHealthSnapshot = { ...healthy, status: "unhealthy", components: {
  ...healthy.components, dataPlane: { ...healthy.components.dataPlane, status: "unhealthy", reason: "heartbeat_timeout", connectedRunners: 1, unresponsiveRunners: 1 },
} };
let client: QueryClient;
function renderPage() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><HealthPage /></QueryClientProvider>);
}
beforeEach(() => { vi.mocked(getControllerSystemHealth).mockReset().mockResolvedValue(healthy); });
afterEach(() => { cleanup(); client?.clear(); vi.useRealTimers(); });

describe("Health tab", () => {
  it("leads with the system conclusion and limits details to the two components", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Healthy", level: 2 })).toBeTruthy();
    expect(screen.getByText("Control plane and data plane are healthy.")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Component details" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("2 of 2 Runners are connected and have reported within the 30s heartbeat timeout.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View Runners" }).getAttribute("href")).toBe("/settings/runner");
    expect(screen.queryByText(/Published protection|Default protection|Active model configuration/i)).toBeNull();
  });
  it("explains an unhealthy component instead of displaying an opaque degraded label", async () => {
    vi.mocked(getControllerSystemHealth).mockResolvedValue(unhealthy);
    renderPage();
    await screen.findByRole("heading", { name: "Unhealthy" });
    expect(screen.getByText("Data plane issue: 1 of 2 Runners are disconnected or have stopped reporting. The control plane is healthy.")).toBeTruthy();
    expect(screen.getByText("Heartbeat timeout")).toBeTruthy();
    expect(screen.queryByText("Degraded")).toBeNull();
  });
  it("retains the existing conclusion and disables duplicate refreshes while a request is pending", async () => {
    let resolve!: (value: SystemHealthSnapshot) => void;
    vi.mocked(getControllerSystemHealth).mockResolvedValueOnce(healthy).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    renderPage();
    await screen.findByRole("heading", { name: "Healthy" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Checking…" }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByRole("heading", { name: "Healthy" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Previous result remains visible");
    await act(async () => { resolve(unhealthy); });
    await screen.findByRole("heading", { name: "Unhealthy" });
  });
  it("clears a stale green result after refresh failure and recovers using Retry", async () => {
    vi.mocked(getControllerSystemHealth).mockResolvedValueOnce(healthy).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(healthy);
    renderPage();
    await screen.findByRole("heading", { name: "Healthy" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("heading", { name: "Unable to confirm" });
    expect(screen.queryByRole("heading", { name: "Healthy" })).toBeNull();
    expect(screen.getAllByText("Not confirmed")).toHaveLength(2);
    expect(screen.queryByText(/2 of 2 Runners/)).toBeNull();
    expect(screen.getByText("Last attempt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("heading", { name: "Healthy" });
    expect(getControllerSystemHealth).toHaveBeenCalledTimes(3);
  });
  it("keeps data-plane health unknown when the Controller reports a storage failure", async () => {
    vi.mocked(getControllerSystemHealth).mockResolvedValue({ ...healthy, status: "unhealthy", components: {
      controlPlane: { status: "unhealthy", reason: "storage_unavailable" },
      dataPlane: { ...healthy.components.dataPlane, status: "unknown", reason: "unknown", connectedRunners: null, totalRunners: null, unresponsiveRunners: null },
    } });
    renderPage();
    await screen.findByRole("heading", { name: "Unhealthy" });
    expect(screen.getByText("Storage unavailable")).toBeTruthy();
    expect(screen.getByText("Not confirmed")).toBeTruthy();
    expect(screen.queryByText(/0 of 0/)).toBeNull();
  });
  it("treats a missing response as unknown", async () => {
    vi.mocked(getControllerSystemHealth).mockResolvedValue(undefined as unknown as SystemHealthSnapshot);
    renderPage();
    await screen.findByRole("heading", { name: "Unable to confirm" });
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
