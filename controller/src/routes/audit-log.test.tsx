import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/controller-api";
import { routeTree } from "@/app-router";
vi.mock("@/routes/layout", () => ({ ControlPlaneLayout: () => <Outlet /> }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => key === "auditLog.eventCount" ? `${values?.count} events` : key, i18n: { language: "en-US", exists: () => false } }),
}));
const before = "2026-09-29T00:00:00.000Z";
const row: api.AuditEvent = { id: "event-1", kind: "guardrail.published", actorId: "admin", resourceType: "guardrail", resourceId: "guardrail-1", occurredAt: before, detail: { name: "Production Guardrail", snapshot: { enabled: false, revision: 0 }, reason: "Reviewed release", ticket: "" } };
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); vi.restoreAllMocks(); });
async function setup(path = `/audit-log?before=${before}`) {
  const list = vi.spyOn(api, "listAuditEvents").mockImplementation(async (query = {}) => ({
    items: [row], total: 1001, page: query.page ?? 1, limit: query.limit ?? 25, before: query.before ?? before,
    facets: { kinds: ["guardrail.published", "endpoint.created"], resourceTypes: ["endpoint", "guardrail"] },
  }));
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, history });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  await router.load();
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  await screen.findByRole("button", { name: "Guardrail · Published" });
  return { list, router, history };
}
describe("audit search workspace", () => {
  it("loads URL filters on the server and shows the full count rather than the page length", async () => {
    const { list } = await setup(`/audit-log?q=production&actor=human&window=all&kind=guardrail.published&resourceType=guardrail&page=2&limit=50&before=${before}`);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "production", actor: "human", window: "all", kind: "guardrail.published", resourceType: "guardrail", page: 2, limit: 50, before }), expect.any(AbortSignal));
    expect(screen.getByText("1001 events")).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
  });
  it("submits keywords, resets paging, and restores the query with Back and Forward", async () => {
    const { router, history } = await setup(`/audit-log?page=3&before=${before}`);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "older policy" } });
    fireEvent.click(screen.getByRole("button", { name: "auditLog.submitSearch" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: "older policy", page: 1, before }));
    history.back();
    await waitFor(() => expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe(""));
    expect(router.state.location.search.page).toBe(3);
    history.forward();
    await waitFor(() => expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("older policy"));
  });
  it("applies filters and removes conditions through the shared toolbar", async () => {
    const { router } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "auditLog.filters" }));
    expect(screen.getByRole("combobox", { name: "auditLog.eventType" }).textContent).toContain("auditLog.allEventTypes");
    expect(screen.getByRole("combobox", { name: "auditLog.resourceType" }).textContent).toContain("auditLog.allResourceTypes");
    fireEvent.click(screen.getByRole("combobox", { name: "auditLog.actorFilter" }));
    fireEvent.click(await screen.findByRole("option", { name: "auditLog.systemActors" }));
    await waitFor(() => expect(router.state.location.search.actor).toBe("system"));
    expect(screen.getByLabelText("auditLog.appliedFilters")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "auditLog.clearFilters" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ actor: "all", page: 1 }));
  });
  it("pins the query cutoff across pages and refreshes from the first page", async () => {
    const { router } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "eventPagination.next" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ page: 2, before }));
    await waitFor(() => expect(screen.getByRole("button", { name: "auditLog.refresh" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "auditLog.refresh" }));
    await waitFor(() => expect(router.state.location.search.page).toBe(1));
    expect(router.state.location.search.before).not.toBe(before);
  });
  it("opens details in the right sheet without leaving the current query", async () => {
    const { router } = await setup(`/audit-log?actor=human&before=${before}`);
    fireEvent.click(screen.getByRole("button", { name: "Guardrail · Published" }));
    const dialog = await screen.findByRole("dialog", { name: "Guardrail · Published" });
    expect(within(dialog).getByText("event-1")).toBeTruthy();
    expect(within(dialog).getByText("Reviewed release")).toBeTruthy();
    expect(within(dialog).getByText("ticket").nextElementSibling?.textContent).toBe("—");
    const snapshot = within(dialog).getByText("snapshot").closest("details")!;
    expect(snapshot.open).toBe(false);
    expect(JSON.parse(snapshot.querySelector("pre")!.textContent!)).toEqual({ enabled: false, revision: 0 });
    expect(within(dialog).getByText("reason").compareDocumentPosition(snapshot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole("button", { name: "common.close" }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.search.actor).toBe("human");
  });
  it("shows an empty-result recovery without a misleading page count", async () => {
    const { list } = await setup();
    list.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 25, before, facets: { kinds: [], resourceTypes: [] } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
    fireEvent.click(screen.getByRole("button", { name: "auditLog.submitSearch" }));
    expect(await screen.findByText("auditLog.noAuditTitle")).toBeTruthy();
    expect(screen.getByText("0 events")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getAllByRole("button", { name: "auditLog.clearFilters" }).length).toBeGreaterThan(0);
  });
  it("offers retry on a failed server query", async () => {
    const { list } = await setup();
    list.mockRejectedValueOnce(new Error("Audit service unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "auditLog.refresh" }));
    expect(await screen.findByText("Audit service unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(await screen.findByRole("button", { name: "Guardrail · Published" })).toBeTruthy();
  });

});
