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
const { save, preview, publish, approve, emergencyApply, withdraw, revert, role } = vi.hoisted(() => ({
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
  getRouterRevisions: async () => ({ items: [{ revision: 1, sourceDraftRevision: 1, snapshot: { routes: [] }, createdAt: "2026-10-01T08:00:00.000Z", createdBy: "approver" }] }),
  saveTrafficRouter: save,
  previewTrafficRouter: preview,
  submitRouterChange: publish,
  approveRouterChange: approve,
  emergencyApplyRouterChange: emergencyApply,
  withdrawRouterChange: withdraw,
  revertRouterChange: revert,
  listRouterChangeRequests: async () => ({ items: [] }),
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
            { field: "protocol", operator: "equals", value: "HTTP" },
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
  expect(screen.getByText("Guardrail 1 version strategy")).toBeTruthy();
  expect(screen.queryByText(/\{\{index\}\}/)).toBeNull();
  expect(screen.queryByText("Test matching")).toBeNull();
  expect(screen.queryByLabelText("Enabled", { exact: true })).toBeNull();
}

describe("Router detail workflow", () => {
  beforeEach(() => {
    role.value = "admin";
    role.id = "submitter";
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
  it("defaults to Overview with five tabs and read-only topology", async () => {
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
    ]);
    await screen.findByRole("heading", { name: "Traffic Flow" });
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
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "Overview" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
  });
  it("lets another administrator approve a pending change exactly once", async () => {
    role.id = "approver";
    mount({ ...router, draftRevision: 2, pendingChangeRequest: pendingChange });
    expect(screen.getByText("Change awaiting approval")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review & submit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    const sheet = await screen.findByRole("dialog", { name: "Review pending change" });
    expect(within(sheet).getByText("Enable partner v2")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Withdraw" })).toBeNull();
    fireEvent.change(within(sheet).getByLabelText("Approval note (optional)"), { target: { value: "CAB approved" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Approve and apply" }));
    await waitFor(() => expect(approve).toHaveBeenCalledExactlyOnceWith("router", "change", "CAB approved"));
  });
  it("requires a reason and manager contact before the submitter applies in an emergency", async () => {
    mount({ ...router, draftRevision: 2, pendingChangeRequest: pendingChange });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    const sheet = await screen.findByRole("dialog", { name: "Review pending change" });
    expect(within(sheet).queryByRole("button", { name: "Approve and apply" })).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Emergency apply" }));
    const apply = within(sheet).getByRole("button", { name: "Apply now" });
    fireEvent.change(within(sheet).getByLabelText("Emergency reason"), { target: { value: "Active abuse" } });
    expect(apply.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(sheet).getByLabelText("Manager contact"), { target: { value: "Duty manager 138" } });
    fireEvent.click(apply);
    await waitFor(() => expect(emergencyApply).toHaveBeenCalledExactlyOnceWith("router", "change", { reason: "Active abuse", managerContact: "Duty manager 138" }));
    expect(approve).not.toHaveBeenCalled();
  });
  it("rolls back the active change to its pre-approved base revision with a reason", async () => {
    mount({ ...router, activeRevision: 2, revertibleChangeRequest: { id: "change", baseRevision: 1, appliedRevision: 2 } });
    fireEvent.click(await screen.findByRole("button", { name: "Roll back to 20261001-080000.000Z" }));
    const sheet = await screen.findByRole("dialog", { name: "Roll back to 20261001-080000.000Z" });
    fireEvent.change(within(sheet).getByLabelText("Rollback reason"), { target: { value: "False positives" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Roll back" }));
    await waitFor(() => expect(revert).toHaveBeenCalledExactlyOnceWith("router", "change", "False positives"));
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
