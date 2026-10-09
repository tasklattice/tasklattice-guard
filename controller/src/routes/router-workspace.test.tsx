import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouterWorkspace } from "./router-detail";
import type { TrafficRouter, RouterChangeRequest, RouterDraft } from "@/lib/traffic-routing-api";
const { save, preview, publish, approve, emergencyApply, withdraw, revert, role, requestRows, changeDetail } = vi.hoisted(() => ({
  requestRows: { items: [] as RouterChangeRequest[] },
  changeDetail: vi.fn(),
  save: vi.fn(),
  preview: vi.fn(),
  publish: vi.fn(),
  approve: vi.fn(),
  emergencyApply: vi.fn(),
  withdraw: vi.fn(),
  revert: vi.fn(),
  role: { value: "admin", id: "submitter" },
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: role.id, role: role.value } }),
}));

const navigation = vi.hoisted(() => ({
  search: {} as { tab?: string; routeId?: string },
  listeners: new Set<() => void>(),
  navigate: vi.fn(),
  blocker: vi.fn(),
}));
vi.mock("@tanstack/react-router", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
    useSearch: () => useSyncExternalStore(
      listener => { navigation.listeners.add(listener); return () => { navigation.listeners.delete(listener); }; },
      () => navigation.search,
    ),
    useNavigate: () => navigation.navigate,
    useParams: () => ({}),
    useBlocker: (options: unknown) => { navigation.blocker(options); return { status: "idle" }; },
  };
});
vi.mock("@/lib/endpoints-api", () => ({
  getEndpoints: async () => ({ items: [] }),
}));
vi.mock("@/lib/controller-api", async (original) => ({
  ...(await original<typeof import("@/lib/controller-api")>()),
  listControllerGuardrails: async () => ({
    items: [{ id: "guard", name: "Main" }],
  }),
  getControllerGuardrail: async () => ({
    versions: [{ version: "1", status: "ready", artifactId: "a" }],
  }),
}));
vi.mock("@/lib/traffic-routing-api", async (original) => ({
  ...(await original<typeof import("@/lib/traffic-routing-api")>()),
  listTrafficRouters: async () => ({ items: [] }),
  getSelectorFields: async () => ({ items: [] }),
  getRouterRevisions: async () => ({ items: [{ revision: 2, sourceDraftRevision: 2, snapshot: { routes: [] }, createdAt: "2026-10-02T08:00:00.000Z", createdBy: "approver" }, { revision: 1, sourceDraftRevision: 1, snapshot: { routes: [] }, createdAt: "2026-10-01T08:00:00.000Z", createdBy: "approver", changeRequestId: "change" }] }),
  saveTrafficRouter: save,
  previewTrafficRouter: preview,
  submitRouterChange: publish,
  approveRouterChange: approve,
  emergencyApplyRouterChange: emergencyApply,
  withdrawRouterChange: withdraw,
  revertRouterChange: revert,
  listRouterChangeRequests: async () => ({ items: requestRows.items }),
  getRouterChangeRequest: changeDetail,
}));
vi.mock("@/components/traffic-routing/distribution", () => ({
  DistributionOverview: () => <div data-testid="monitoring-distribution">Runtime distribution</div>,
}));
const draft: RouterDraft = {
  routes: [
    {
      id: "partner",
      name: "Partner traffic",
      kind: "normal",
      enabled: true,
      selector: {
        expression: {
          combinator: "and",
          conditions: [
            { field: "protocol", operator: "equals", value: "litellm" },
          ],
        },
      },
      targets: [
        {
          id: "target",
          guardrailId: "guard",
          guardrailVersion: "1",
          weightBps: 10000,
        },
      ],
    },
    {
      id: "fallback",
      name: "Fallback",
      kind: "fallback",
      enabled: true,
      selector: { expression: { combinator: "and", conditions: [] } },
      targets: [
        {
          id: "fallback-target",
          guardrailId: "guard",
          guardrailVersion: "1",
          weightBps: 10000,
        },
      ],
    },
  ],
};
const router: TrafficRouter = {
  id: "router",
  name: "Support",
  description: "",
  endpointIds: [],
  draftRevision: 1,
  activeRevision: 1,
  activeDraftRevision: 1,
  rolloutStatus: "active",
  draft,
  activeSnapshot: structuredClone(draft),
  desiredGeneration: 1,
  updatedAt: "",
  pendingChangeRequest: null,
  revertibleChangeRequest: null,
};
const pendingChange: RouterChangeRequest = {
  id: "change", routerId: "router", kind: "publish", status: "pending", sourceDraftRevision: 2, baseRevision: 1,
  snapshot: draft, endpointIds: [], context: null, ticket: "CHG-7", reason: "Enable partner v2",
  submittedBy: "submitter", submittedByName: "Submitter", submittedAt: "2026-10-07T10:00:00.000Z",
  decidedBy: null, decidedByName: null, decidedAt: null, decisionNote: null, emergencyReason: null, emergencyContact: null,
  appliedRevision: null, revertsChangeRequestId: null,
};
function mount(value = router) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <RouterWorkspace router={value} />
    </QueryClientProvider>,
  );
}
async function edit() {
  fireEvent.click(screen.getByRole("tab", { name: "Routing", exact: true }), { button: 0, ctrlKey: false });
  await screen.findByRole("button", { name: /01 Partner traffic/ });
  fireEvent.click(
    await screen.findByRole("button", { name: "Actions for Partner traffic" }),
    { button: 0, pointerType: "mouse", ctrlKey: false },
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Edit", exact: true }),
  );
  await screen.findByLabelText("Route name");
  // Every target pins a version; there is no strategy to choose.
  expect(screen.queryByText("Guardrail 1 version strategy")).toBeNull();
  expect(screen.getAllByLabelText(/Guardrail 1 version/).length).toBeGreaterThan(0);
  expect(screen.queryByText(/\{\{index\}\}/)).toBeNull();
  expect(screen.queryByText("Test matching")).toBeNull();
  expect(screen.queryByLabelText("Enabled", { exact: true })).toBeNull();
}

describe("Router detail workflow", () => {
  beforeEach(() => {
    role.value = "admin";
    role.id = "submitter";
    requestRows.items = [];
    changeDetail.mockImplementation(async (_id: string, id: string) => requestRows.items.find(item => item.id === id) ?? pendingChange);
    navigation.search = {};
    navigation.navigate.mockImplementation(({ search }: { search: (previous: typeof navigation.search) => typeof navigation.search }) => {
      navigation.search = search(navigation.search);
      navigation.listeners.forEach(listener => listener());
      return Promise.resolve();
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    save.mockImplementation(async (_id, _rev, next) => ({
      ...router,
      draft: next,
      draftRevision: 2,
    }));
    preview.mockResolvedValue({
      draftRevision: 2,
      snapshot: draft,
      endpointIds: [],
    });
    publish.mockResolvedValue(pendingChange);
    approve.mockResolvedValue({ ...router, activeRevision: 2 });
    emergencyApply.mockResolvedValue({ ...router, activeRevision: 2 });
    withdraw.mockResolvedValue({ ...pendingChange, status: "withdrawn" });
    revert.mockResolvedValue({ ...router, activeRevision: 3 });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });
  it("defaults to Overview with six tabs and read-only topology", async () => {
    mount();
    expect(
      screen
        .getByRole("tab", { name: "Overview" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Overview",
      "Endpoints",
      "Routing",
      "Monitoring",
      "Revisions",
      "Change Requests",
    ]);
    await screen.findByRole("heading", { name: "Traffic Flow" });
    expect(screen.queryByText("Published routing rules")).toBeNull();
    expect(screen.queryByText("Pinned in the published revision")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save rules" })).toBeNull();
    for (const name of ["Edit routing", "Rename Router", "View revisions"]) {
      expect(screen.queryByRole("button", { name, exact: true })).toBeNull();
    }
    expect(screen.queryByLabelText("Route name")).toBeNull();
  });
  it("writes tab changes to the URL and restores externally changed search without remounting", async () => {
    navigation.search = { tab: "monitoring", routeId: "partner" };
    mount();
    expect(screen.getByRole("tab", { name: "Monitoring" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(navigation.search).toEqual({ tab: "overview", routeId: "partner" });
    act(() => {
      navigation.search = { tab: "monitoring", routeId: "partner" };
      navigation.listeners.forEach(listener => listener());
    });
    expect(screen.getByRole("tab", { name: "Monitoring" }).getAttribute("aria-selected")).toBe("true");
    await screen.findByTestId("monitoring-distribution");
  });
  it("normalizes a route deep link using replace and preserves drafts across tab navigation", async () => {
    navigation.search = { routeId: "partner" };
    mount();
    expect(navigation.navigate).toHaveBeenCalledWith(expect.objectContaining({ replace: true, resetScroll: false }));
    expect(navigation.search).toEqual({ tab: "routing", routeId: "partner" });
    await edit();
    fireEvent.change(screen.getByLabelText("Route name"), { target: { value: "Unsaved partner" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes", exact: true }));
    fireEvent.click(screen.getByRole("tab", { name: "Monitoring" }));
    fireEvent.click(screen.getByRole("tab", { name: "Routing", exact: true }));
    expect(await screen.findByRole("button", { name: /01 Unsaved partner/ })).toBeTruthy();
    const { shouldBlockFn } = navigation.blocker.mock.calls.at(-1)![0];
    expect(shouldBlockFn({ current: { pathname: "/integration/routers/one" }, next: { pathname: "/integration/routers/one" } })).toBe(false);
    expect(shouldBlockFn({ current: { pathname: "/integration/routers/one" }, next: { pathname: "/integration/routers/two" } })).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
  it("isolates runtime metrics in Monitoring and keeps Overview static", async () => {
    mount();
    await screen.findByRole("heading", { name: "Traffic Flow" });
    expect(screen.queryByTestId("monitoring-distribution")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Monitoring" }), { button: 0, ctrlKey: false });
    await screen.findByTestId("monitoring-distribution");
    expect(screen.queryByRole("heading", { name: "Traffic Flow" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }), { button: 0, ctrlKey: false });
    await screen.findByRole("heading", { name: "Traffic Flow" });
    expect(screen.queryByTestId("monitoring-distribution")).toBeNull();
  });
  it("opens matching rule from topology without entering edit mode", async () => {
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: /01 · Partner traffic/ }),
    );
    expect(
      screen
        .getByRole("tab", { name: "Routing" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: /01 Partner traffic/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.queryByLabelText("Route name")).toBeNull();
  });
  it("keeps local edits after failed Review persistence", async () => {
    save.mockRejectedValueOnce(new Error("Save unavailable"));
    mount();
    await edit();
    fireEvent.change(screen.getByLabelText("Route name"), {
      target: { value: "Updated partner" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Apply changes", exact: true }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    await screen.findByRole("button", { name: "Retry review" });
    expect(
      screen.getByRole("button", { name: "01 Updated partner" }),
    ).toBeTruthy();
    expect(publish).not.toHaveBeenCalled();
  });
  it("reviews resolved versions and submits the exact reviewed snapshot for approval", async () => {
    mount();
    await edit();
    fireEvent.change(screen.getByLabelText("Route name"), {
      target: { value: "Updated partner" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Apply changes", exact: true }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    await screen.findByRole("heading", { name: "Review routing changes" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith("router", 2);
    const submit = screen.getByRole("button", { name: "Submit for approval" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Change description"), { target: { value: " Rename partner route " } });
    fireEvent.change(screen.getByLabelText("Change ticket (optional)"), { target: { value: "CHG-7" } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith("router", {
        expectedDraftRevision: 2,
        reviewedSnapshot: draft,
        reviewedEndpointIds: [],
        reason: "Rename partner route",
        ticket: "CHG-7",
      }),
    );
    await waitFor(() => expect(navigation.search.tab).toBe("change-requests"));
    expect(await screen.findByRole("dialog", { name: "Review pending change" })).toBeTruthy();
  });
  it("separates request history from revisions and links their drawers in both directions", async () => {
    requestRows.items = [{ ...pendingChange, status: "applied", appliedRevision: 1, decidedAt: "2026-10-07T10:05:00Z", decidedBy: "approver" }];
    navigation.search = { tab: "revisions" };
    mount();
    expect(await screen.findByRole("button", { name: "20261001-080000.000Z" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Enable partner v2" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Deployment history" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "20261001-080000.000Z" }));
    fireEvent.click(await screen.findByRole("button", { name: "View change request" }));
    await screen.findByRole("button", { name: "View published revision" });
    const sheet = screen.getByRole("dialog", { name: "Change request", exact: true });
    expect(within(sheet).queryByRole("button", { name: "Approve and apply" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Withdraw request" })).toBeNull();
    // The active snapshot already matches the request; only the historical base has a diff.
    expect(within(sheet).getByRole("region", { name: "Routing configuration diff" })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "View published revision" }));
    expect(await screen.findByRole("dialog", { name: "Revision 20261001-080000.000Z" })).toBeTruthy();
    expect(navigation.search.tab).toBe("revisions");
  });
  it("prioritizes pending requests, paginates history, and resets pagination on filtering", async () => {
    requestRows.items = [
      ...Array.from({ length: 11 }, (_, i) => ({ ...pendingChange, id: `closed-${i}`, reason: `Closed ${i}`, status: "withdrawn" as const, submittedAt: `2026-10-${String(i + 8).padStart(2, "0")}T10:00:00Z` })),
      pendingChange,
    ];
    navigation.search = { tab: "change-requests" };
    mount({ ...router, pendingChangeRequest: pendingChange });
    expect(screen.getByRole("tab", { name: "Change Requests 1" })).toBeTruthy();
    await screen.findByRole("button", { name: "Enable partner v2" });
    expect(screen.getAllByRole("row")[1]?.textContent).toContain("Enable partner v2");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.queryByRole("button", { name: "Enable partner v2" })).toBeNull();
    fireEvent.click(screen.getByRole("combobox", { name: "Filter requests by status" }));
    fireEvent.click(await screen.findByRole("option", { name: "Awaiting approval" }));
    expect(screen.getByRole("button", { name: "Enable partner v2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });
  it("keeps withdrawn requests read-only for their submitter", async () => {
    requestRows.items = [{ ...pendingChange, status: "withdrawn" }];
    navigation.search = { tab: "change-requests" };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Enable partner v2" }));
    await screen.findByText("This request is closed. Its decision and submitted configuration are retained for reference.");
    const sheet = screen.getByRole("dialog", { name: "Change request", exact: true });
    expect(within(sheet).getByText("Withdrawn")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Withdraw request" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Emergency apply" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Approve and apply" })).toBeNull();
  });
  it("lets another administrator approve a pending change exactly once", async () => {
    role.id = "approver";
    mount({ ...router, draftRevision: 2, pendingChangeRequest: pendingChange });
    expect(screen.getByText("Change awaiting approval")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review & submit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    const sheet = await screen.findByRole("dialog", { name: "Review pending change" });
    expect(within(sheet).getByText("Enable partner v2")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Withdraw request" })).toBeNull();
    fireEvent.change(within(sheet).getByLabelText("Approval note (optional)"), { target: { value: "CAB approved" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Approve and apply" }));
    await waitFor(() => expect(approve).toHaveBeenCalledExactlyOnceWith("router", "change", "CAB approved"));
  });
  it("keeps the applied request open with a published-version link after approval", async () => {
    role.id = "approver";
    approve.mockImplementationOnce(async () => {
      changeDetail.mockResolvedValue({ ...pendingChange, status: "applied", appliedRevision: 1 });
      return router;
    });
    mount({ ...router, pendingChangeRequest: pendingChange });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve and apply" }));
    expect(await screen.findByRole("button", { name: "View published revision" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve and apply" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Change request", exact: true })).toBeTruthy();
  });
  it("does not expose approval controls when request detail loading fails", async () => {
    changeDetail.mockRejectedValueOnce(new Error("Request unavailable"));
    mount({ ...router, pendingChangeRequest: pendingChange });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    expect(await screen.findByText("Request unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve and apply" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Withdraw request" })).toBeTruthy();
  });
  it("requires only a nonblank reason before the submitter applies in an emergency", async () => {
    mount({ ...router, draftRevision: 2, pendingChangeRequest: pendingChange });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    const sheet = await screen.findByRole("dialog", { name: "Review pending change" });
    expect(within(sheet).queryByRole("button", { name: "Approve and apply" })).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Emergency apply" }));
    const apply = within(sheet).getByRole("button", { name: "Apply now" });
    expect(apply.hasAttribute("disabled")).toBe(true);
    expect(within(sheet).queryByLabelText("Manager contact")).toBeNull();
    fireEvent.change(within(sheet).getByLabelText("Emergency reason"), { target: { value: "   " } });
    expect(apply.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(sheet).getByLabelText("Emergency reason"), { target: { value: " Active abuse " } });
    expect(apply.hasAttribute("disabled")).toBe(false);
    fireEvent.click(apply);
    await waitFor(() => expect(emergencyApply).toHaveBeenCalledExactlyOnceWith("router", "change", { reason: "Active abuse" }));
    expect(approve).not.toHaveBeenCalled();
  });
  async function openRestore(value = { ...router, activeRevision: 2 }) {
    mount(value);
    expect(screen.queryByRole("button", { name: "Actions", exact: true })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Revisions", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Actions for revision 20261001-080000.000Z" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore this version…" }));
    return screen.findByRole("dialog", { name: "Restore 20261001-080000.000Z", exact: true });
  }
  it("submits a chosen historical version for approval without calling direct rollback", async () => {
    publish.mockResolvedValueOnce({ ...pendingChange, snapshot: { routes: [] } });
    const sheet = await openRestore();
    expect(within(sheet).getByText("20261002-080000.000Z")).toBeTruthy();
    expect(within(sheet).getByText("20261001-080000.000Z")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Submit for approval" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(sheet).getByLabelText("Change description"), { target: { value: "Restore stable routing" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Submit for approval" }));
    await waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith("router", {
      expectedDraftRevision: 1, restore: { revision: 1, expectedActiveRevision: 2 },
      reviewedSnapshot: { routes: [] }, reviewedEndpointIds: [], reason: "Restore stable routing", ticket: "",
    }));
    expect(await screen.findByRole("dialog", { name: "Review pending change" })).toBeTruthy();
    expect(navigation.search.tab).toBe("change-requests");
    expect(revert).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });
  it("cancels restoration without changing the draft or submitting a request", async () => {
    const sheet = await openRestore();
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(publish).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(revert).not.toHaveBeenCalled();
  });
  it("explains why restoration cannot submit while another request is pending", async () => {
    const sheet = await openRestore({ ...router, activeRevision: 2, pendingChangeRequest: pendingChange });
    fireEvent.change(within(sheet).getByLabelText("Change description"), { target: { value: "Restore" } });
    expect(within(sheet).getByRole("alert").textContent).toContain("already has a pending change request");
    expect(within(sheet).getByRole("button", { name: "Submit for approval" }).hasAttribute("disabled")).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  });
  it("keeps a failed restoration review open and allows retry", async () => {
    publish.mockRejectedValueOnce(new Error("Target is no longer available"));
    const sheet = await openRestore();
    fireEvent.change(within(sheet).getByLabelText("Change description"), { target: { value: "Restore" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Submit for approval" }));
    expect(await within(sheet).findByText("Target is no longer available")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Submit for approval" }).hasAttribute("disabled")).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
  it("keeps fallback separate, without delete or reorder", async () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Routing", exact: true }), { button: 0, ctrlKey: false });
    fireEvent.click(
      await screen.findByRole("button", { name: /Fallback · All unmatched/ }),
    );
    const article = screen
      .getByRole("button", { name: /Fallback · All unmatched/ })
      .closest("article")!;
    expect(
      within(article).queryByRole("button", { name: "Delete rule" }),
    ).toBeNull();
    expect(within(article).queryByLabelText(/Reorder/)).toBeNull();
    expect(
      within(article).queryByRole("button", { name: "Add Guardrail" }),
    ).toBeNull();
  });
  it("creates in a side sheet and cancels without inserting an empty rule", async () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Routing" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Add routing rule" }),
    );
    const sheet = await screen.findByRole("dialog", {
      name: "Create routing rule",
    });
    expect(within(sheet).queryByText("Test matching")).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Test Selector" })).toBeNull();
    fireEvent.change(within(sheet).getByLabelText("Route name"), {
      target: { value: "Abandoned rule" },
    });
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Add rule", exact: true }),
    );
    expect(within(sheet).getByRole("alert")).toBeTruthy();
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Cancel", exact: true }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /Abandoned rule/ })).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
  it("confirms row deletion without publishing and lets cancellation preserve the rule", async () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Routing" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      await screen.findAllByRole("button", { name: "Add routing rule" }),
    ).toHaveLength(1);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Actions for Partner traffic",
      }),
      { button: 0, pointerType: "mouse", ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete", exact: true }),
    );
    let sheet = await screen.findByRole("dialog", {
      name: "Delete routing rule?",
    });
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Cancel", exact: true }),
    );
    expect(
      screen.getByRole("button", { name: "01 Partner traffic" }),
    ).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Actions for Partner traffic",
      }),
      { button: 0, pointerType: "mouse", ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete", exact: true }),
    );
    sheet = await screen.findByRole("dialog", { name: "Delete routing rule?" });
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Delete rule", exact: true }),
    );
    expect(
      screen.queryByRole("button", { name: "01 Partner traffic" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /Fallback · All unmatched/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Duplicate", exact: true }),
    ).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
  it("offers no edit controls to viewers", async () => {
    role.value = "viewer";
    mount();
    await screen.findByRole("heading", { name: "Traffic Flow" });
    expect(screen.queryByRole("button", { name: "Edit routing" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Roll back/ })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Endpoints" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      screen.queryByRole("button", { name: "Attach endpoint" }),
    ).toBeNull();
  });
});
