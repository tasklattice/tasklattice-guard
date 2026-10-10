import "@/i18n";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutersPage } from "./routers";
import type { TrafficRouter } from "@/lib/traffic-routing-api";

const mocks = vi.hoisted(() => ({ role: "admin", list: vi.fn(), revisions: vi.fn(), get: vi.fn(), remove: vi.fn(), navigate: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: mocks.role } }) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children, to, params, search, ...props }: { children: ReactNode; to: string; params?: { routerId: string }; search?: Record<string, string> }) => <a {...props} href={to.replace("$routerId", params?.routerId ?? "") + (search ? `?${new URLSearchParams(search)}` : "")}>{children}</a>,
}));
vi.mock("@/components/traffic-routing/create-router-sheet", () => ({ CreateRouterSheet: () => null }));
vi.mock("@/lib/api", () => ({ getEndpoints: async () => ({ items: [{ id: "endpoint", name: "Gateway" }] }) }));
vi.mock("@/lib/traffic-routing-api", async original => ({
  ...await original<typeof import("@/lib/traffic-routing-api")>(),
  listTrafficRouters: mocks.list,
  getRouterRevisions: mocks.revisions,
  getTrafficRouter: mocks.get,
  deleteTrafficRouter: mocks.remove,
  getRouterDistribution: async () => ({ total: 0, rows: [] }),
}));

const router: TrafficRouter = {
  id: "router", name: "Production", description: "", endpointIds: [],
  draftRevision: 1, activeDraftRevision: 1, activeRevision: 1, rolloutStatus: "active",
  draft: { routes: [] }, activeSnapshot: { routes: [] }, desiredGeneration: 1,
  updatedAt: "2026-10-09T12:00:00.000Z", pendingChangeRequest: null, revertibleChangeRequest: null,
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><RoutersPage /></QueryClientProvider>);
  return client;
}
async function openDelete() {
  fireEvent.click(await screen.findByRole("button", { name: "Actions: Production" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete", exact: true }));
  return within(await screen.findByRole("dialog", { name: "Delete Router" }));
}

describe("Router list actions and publication state", () => {
  beforeEach(() => {
    mocks.role = "admin";
    mocks.navigate.mockReset();
    mocks.list.mockReset().mockResolvedValue({ items: [router] });
    mocks.revisions.mockReset().mockResolvedValue({ items: [
      { revision: 2, createdAt: "2026-10-02T08:00:00.000Z" },
      { revision: 1, createdAt: "2026-10-01T08:00:00.000Z" },
    ] });
    mocks.get.mockReset().mockResolvedValue(router);
    mocks.remove.mockReset().mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it("uses the active revision's timestamp rather than its sequence, the latest revision, or Router update time", async () => {
    mount();
    const badge = await screen.findByRole("img", { name: "20261001-080000.000Z · Active" });
    expect(badge.textContent).toBe("20261001-080000.000Z");
    expect(screen.queryByText("Active", { exact: true })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Published revision" })).toBeTruthy();
  });

  it.each([
    ["distributing", 1, "20261001-080000.000Z · Distributing"],
    ["failed", 1, "20261001-080000.000Z · Rollout failed"],
    ["unpublished", null, "Unpublished"],
  ] as const)("keeps %s explicit", async (rolloutStatus, activeRevision, label) => {
    mocks.list.mockResolvedValue({ items: [{ ...router, rolloutStatus, activeRevision }] });
    mount();
    expect((await screen.findByRole("img", { name: label })).textContent).toBe(label);
    if (activeRevision === null) expect(mocks.revisions).not.toHaveBeenCalled();
  });

  it("preserves the known status without inventing a version if revision metadata is unavailable", async () => {
    mocks.revisions.mockRejectedValue(new Error("Cannot load revisions"));
    const client = mount();
    await waitFor(() => expect(client.getQueryState(["traffic-routers", "router", "revisions"])?.status).toBe("error"));
    expect(screen.getByRole("img", { name: "Active", exact: true }).textContent).toBe("Active");
    expect(screen.queryByText(/^r1$/i)).toBeNull();
  });

  it("does not offer Delete to read-only users", async () => {
    mocks.role = "viewer";
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Actions: Production" }));
    expect(await screen.findByRole("menuitem", { name: "View details" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });

  it("checks current bindings and explains how to unblock deletion without navigating on open", async () => {
    mocks.get.mockResolvedValue({ ...router, endpointIds: ["endpoint"] });
    mount();
    const sheet = await openDelete();
    expect(await sheet.findByText("This Router has 1 bound Endpoints. Unbind them before deleting it.")).toBeTruthy();
    expect(sheet.getByRole("button", { name: "Delete Router" }).matches(":disabled")).toBe(true);
    expect(sheet.getByRole("link", { name: "Manage Endpoints" }).getAttribute("href")).toBe("/integration/routers/router?tab=endpoints");
    fireEvent.click(sheet.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("blocks deletion if bindings cannot be checked, then supports retry", async () => {
    mocks.get.mockRejectedValueOnce(new Error("Cannot load Router"));
    mount();
    const sheet = await openDelete();
    expect(await sheet.findByText("Cannot load Router")).toBeTruthy();
    expect(sheet.getByRole("button", { name: "Delete Router" }).matches(":disabled")).toBe(true);
    fireEvent.click(sheet.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(sheet.getByRole("button", { name: "Delete Router" }).matches(":disabled")).toBe(false));
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("preserves the confirmation after server rejection and refreshes the list after successful deletion", async () => {
    mocks.remove.mockRejectedValueOnce(new Error("Unbind Endpoints before deleting this Router."));
    mount();
    const sheet = await openDelete();
    const confirm = sheet.getByRole("button", { name: "Delete Router" });
    await waitFor(() => expect(confirm.matches(":disabled")).toBe(false));
    fireEvent.click(confirm);
    expect(await sheet.findByText("Unbind Endpoints before deleting this Router.")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Delete Router" })).toBeTruthy();
    await waitFor(() => expect(confirm.matches(":disabled")).toBe(false));
    mocks.list.mockResolvedValue({ items: [] });
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.remove).toHaveBeenNthCalledWith(2, "router");
    expect(await screen.findByText("No Routers yet")).toBeTruthy();
  });

  it("prevents duplicate submissions and closing while deletion is pending", async () => {
    let finish!: () => void;
    mocks.remove.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    mount();
    const sheet = await openDelete();
    const confirm = sheet.getByRole("button", { name: "Delete Router" });
    await waitFor(() => expect(confirm.matches(":disabled")).toBe(false));
    fireEvent.click(confirm);
    expect((await sheet.findByRole("button", { name: "Deleting…" })).matches(":disabled")).toBe(true);
    expect(sheet.getByRole("button", { name: "Cancel" }).matches(":disabled")).toBe(true);
    fireEvent.click(confirm);
    expect(mocks.remove).toHaveBeenCalledOnce();
    mocks.list.mockResolvedValue({ items: [] });
    finish();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
