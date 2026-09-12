import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouterWorkspace } from "./router-detail";
import type { TrafficRouter, RouterDraft } from "@/lib/traffic-routing-api";
const { save, preview, publish, role } = vi.hoisted(() => ({
  save: vi.fn(),
  preview: vi.fn(),
  publish: vi.fn(),
  role: { value: "admin" },
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { role: role.value } }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", exists: () => false },
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: {
    children: React.ReactNode;
    to: string;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useSearch: () => ({}),
  useParams: () => ({}),
  useBlocker: () => ({ status: "idle" }),
}));
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
  getRouterRevisions: async () => ({ items: [] }),
  saveTrafficRouter: save,
  previewTrafficRouter: preview,
  publishTrafficRouter: publish,
}));
vi.mock("@/components/traffic-routing/distribution", () => ({
  DistributionOverview: () => <div data-testid="monitoring-distribution">Runtime distribution</div>,
}));
vi.mock("@/components/traffic-routing/selector-preview", () => ({
  SelectorPreviewPanel: () => null,
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
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Routing", exact: true }), { button: 0, ctrlKey: false });
  await screen.findByRole("button", { name: /01 Partner traffic/ });
  fireEvent.pointerDown(
    await screen.findByRole("button", { name: "Actions for Partner traffic" }),
    { button: 0, pointerType: "mouse", ctrlKey: false },
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Edit", exact: true }),
  );
  await screen.findByLabelText("Route name");
  expect(screen.queryByLabelText("Enabled", { exact: true })).toBeNull();
}

describe("Router detail workflow", () => {
  beforeEach(() => {
    role.value = "admin";
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
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
    publish.mockResolvedValue({
      ...router,
      activeRevision: 2,
      activeDraftRevision: 2,
      draftRevision: 2,
    });
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
  it("isolates runtime metrics in Monitoring and keeps Overview static", async () => {
    mount();
    await screen.findByRole("heading", { name: "Traffic Flow" });
    expect(screen.queryByTestId("monitoring-distribution")).toBeNull();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Monitoring" }), { button: 0, ctrlKey: false });
    await screen.findByTestId("monitoring-distribution");
    expect(screen.queryByRole("heading", { name: "Traffic Flow" })).toBeNull();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Overview" }), { button: 0, ctrlKey: false });
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
  it("reviews resolved versions and publishes the exact reviewed snapshot", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Publish revision" }));
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith("router", 2, expect.any(String), {
        reviewedSnapshot: draft,
        reviewedEndpointIds: [],
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
  it("keeps fallback separate, without delete or reorder", async () => {
    mount();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Routing", exact: true }), { button: 0, ctrlKey: false });
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
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Routing" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Add routing rule" }),
    );
    const sheet = await screen.findByRole("dialog", {
      name: "Create routing rule",
    });
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
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Routing" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      await screen.findAllByRole("button", { name: "Add routing rule" }),
    ).toHaveLength(1);
    fireEvent.pointerDown(
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
    fireEvent.pointerDown(
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
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Endpoints" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      screen.queryByRole("button", { name: "Attach endpoint" }),
    ).toBeNull();
  });
});
