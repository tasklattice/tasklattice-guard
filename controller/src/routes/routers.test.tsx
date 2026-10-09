import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routingIssues, type RouterDraft } from "../../shared/traffic-routing";
import { CreateRouterSheet } from "./routers";

const { create, fields } = vi.hoisted(() => ({ create: vi.fn(), fields: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));
vi.mock("@/lib/controller-api", async original => ({
  ...(await original<typeof import("@/lib/controller-api")>()),
  listControllerEndpoints: async () => ({ items: [
    { id: "endpoint-cn", name: "Gateway CN", adapter: "LITELLM" },
    { id: "endpoint-owned", name: "Gateway owned", adapter: "LITELLM" },
  ] }),
  listControllerGuardrails: async () => ({ items: [{ id: "guard", name: "Main Guardrail" }] }),
  getControllerGuardrail: async () => ({ versions: [{ version: "v1", status: "ready", artifactId: "artifact" }] }),
}));
vi.mock("@/lib/traffic-routing-api", async original => ({
  ...(await original<typeof import("@/lib/traffic-routing-api")>()),
  listTrafficRouters: async () => ({ items: [{ id: "other", name: "Other router", endpointIds: ["endpoint-owned"] }] }),
  getSelectorFields: fields,
  createTrafficRouter: create,
}));

function mount() {
  const onCreated = vi.fn();
  const onOpenChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><CreateRouterSheet open onOpenChange={onOpenChange} onCreated={onCreated} /></QueryClientProvider>);
  return { onCreated, onOpenChange };
}

async function chooseEndpoint() {
  const source = screen.getByRole("combobox", { name: "Source Endpoints" });
  const toggle = screen.getByRole("button", { name: "Open options for Source Endpoints" });
  await waitFor(() => expect(toggle.matches(":disabled")).toBe(false));
  fireEvent.click(toggle);
  // Carbon's auto-aligned menus remain visibility:hidden in JSDOM without layout.
  const owned = await screen.findByText("Gateway owned", { exact: true });
  expect(owned.closest('[role="option"]')?.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByText("Gateway CN", { exact: true }));
  fireEvent.keyDown(source, { key: "Escape" });
  await waitFor(() => expect(fields).toHaveBeenCalledWith(["endpoint-cn"]));
}

async function configureSource(name: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Router name", exact: true }), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await chooseEndpoint();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
}

async function chooseGuardrail(container: HTMLElement) {
  const area = within(container);
  const add = area.getByRole("button", { name: "Add Guardrail", exact: true });
  await waitFor(() => expect(add.matches(":disabled")).toBe(false));
  fireEvent.click(add);
  fireEvent.keyDown(area.getByRole("combobox", { name: "Guardrail 1", exact: true }), { key: "ArrowDown" });
  fireEvent.click(await area.findByText("Main Guardrail", { exact: true }));
  const version = await area.findByRole("combobox", { name: "Guardrail 1 version", exact: true });
  fireEvent.keyDown(version, { key: "ArrowDown" });
  fireEvent.click(await area.findByText("v1", { exact: true }));
}

async function configureRule(number: number, value: string) {
  const rule = screen.getByRole("article", { name: `Rule ${number}` });
  fireEvent.click(within(rule).getByRole("button", { name: "Add condition", exact: true }));
  await waitFor(() => expect(within(within(rule).getByTestId("fields")).getByRole("combobox").textContent).toContain("protocol"));
  fireEvent.change(within(rule).getByLabelText("Value"), { target: { value } });
  await chooseGuardrail(rule);
}

const fallbackRegion = () => screen.getByRole("region", { name: "Otherwise · Fallback route" });

describe("Router creation", () => {
  beforeEach(() => {
    create.mockReset().mockResolvedValue({ id: "router" });
    fields.mockReset().mockResolvedValue({ items: [{ id: "protocol", label: "protocol", group: "protocol", cardinality: "one", operators: ["equals"] }] });
  });
  afterEach(cleanup);

  it("shows one step at a time and gates progression and creation on complete configuration", async () => {
    const { onOpenChange } = mount();
    expect(await screen.findByRole("heading", { name: "Create Router" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Router name", exact: true })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Source Endpoints" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Traffic destinations" })).toBeNull();
    expect(screen.queryByText("01")).toBeNull();
    expect(screen.getByRole("button", { name: "Next" }).matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    fireEvent.change(screen.getByRole("textbox", { name: "Router name", exact: true }), { target: { value: "Production" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.queryByRole("textbox", { name: "Router name", exact: true })).toBeNull();
    expect(screen.getByRole("region", { name: "Traffic source" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" }).matches(":disabled")).toBe(true);
    await chooseEndpoint();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const destinations = screen.getByRole("region", { name: "Traffic destinations" });
    expect(within(destinations).getByRole("heading", { name: "Conditional routes" })).toBeTruthy();
    expect(destinations.contains(fallbackRegion())).toBe(true);
    expect(screen.queryByRole("region", { name: "Traffic source" })).toBeNull();
    expect(screen.getByRole("button", { name: "Review configuration" }).matches(":disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Create Router", exact: true })).toBeNull();

    // Guardrail-style sidebar navigation is free, but cannot bypass validation to create.
    fireEvent.click(screen.getByRole("tab", { name: /Review & create/ }));
    expect(screen.getByRole("region", { name: "Review your Router" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Router", exact: true }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("tab", { name: /Review & create/ }).getAttribute("aria-current")).toBe("step");
    expect(create).not.toHaveBeenCalled();
  });

  it("retains name, Endpoints, conditions and pinned targets through previous, next and review edits", async () => {
    mount();
    await configureSource("Production");
    await configureRule(1, "litellm");
    await chooseGuardrail(fallbackRegion());
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByRole("button", { name: "Remove Gateway CN" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect((screen.getByRole("textbox", { name: "Router name", exact: true }) as HTMLInputElement).value).toBe("Production");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect((screen.getByLabelText("Value") as HTMLInputElement).value).toBe("litellm");
    const rule = within(screen.getByRole("article", { name: "Rule 1" }));
    await waitFor(() => expect(rule.getByRole("combobox", { name: "Guardrail 1 version" }).textContent).toContain("v1"));
    fireEvent.click(screen.getByRole("button", { name: "Review configuration" }));
    const review = within(screen.getByRole("region", { name: "Review your Router" }));
    expect(review.getByText("Production")).toBeTruthy();
    expect(review.getByText("Gateway CN")).toBeTruthy();
    expect(review.getByText(/protocol equals "litellm"/)).toBeTruthy();
    expect(review.getAllByText("Main Guardrail · v1 · 100%")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Create Router", exact: true }).matches(":disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Edit traffic destinations" }));
    expect((screen.getByLabelText("Value") as HTMLInputElement).value).toBe("litellm");
    expect(create).not.toHaveBeenCalled();
  });

  it("preserves edited conditions and targets through collapse and reorder, then submits fallback last", async () => {
    const { onCreated } = mount();
    await configureSource("  Production  ");
    await configureRule(1, "litellm");
    fireEvent.click(screen.getByRole("button", { name: "Add conditional route" }));
    const first = within(screen.getByRole("article", { name: "Rule 1" }));
    expect(first.getByRole("button", { name: "Expand" }).getAttribute("aria-expanded")).toBe("false");
    expect(first.getByText(/protocol equals "litellm"/)).toBeTruthy();
    expect(first.getByText("Main Guardrail · 100%")).toBeTruthy();
    await configureRule(2, "scan");
    fireEvent.click(screen.getByRole("button", { name: "Move Rule 2 up" }));
    const second = within(screen.getByRole("article", { name: "Rule 2" }));
    fireEvent.click(second.getByRole("button", { name: "Expand" }));
    expect((second.getByLabelText("Value") as HTMLInputElement).value).toBe("litellm");
    expect(second.getByRole("combobox", { name: "Guardrail 1 version" }).textContent).toContain("v1");
    await chooseGuardrail(fallbackRegion());
    expect(within(fallbackRegion()).queryByRole("button", { name: "Add Guardrail" })).toBeNull();
    expect(within(fallbackRegion()).queryByRole("button", { name: /Remove|Move/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review configuration" }));
    const submit = screen.getByRole("button", { name: "Create Router", exact: true });
    await waitFor(() => expect(submit.matches(":disabled")).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    const input = create.mock.calls[0]![0] as { name: string; endpointIds: string[]; draft: RouterDraft };
    expect(input.name).toBe("Production");
    expect(input.endpointIds).toEqual(["endpoint-cn"]);
    expect(input.draft.routes.map(r => r.kind)).toEqual(["normal", "normal", "fallback"]);
    expect(input.draft.routes.map(r => r.selector.expression.conditions)).toMatchObject([
      [{ field: "protocol", value: "scan" }],
      [{ field: "protocol", value: "litellm" }],
      [],
    ]);
    expect(input.draft.routes.at(-1)?.targets).toMatchObject([{ guardrailId: "guard", guardrailVersion: "v1", weightBps: 10000 }]);
    expect(routingIssues(input.draft, true)).toEqual([]);
  });

  it("supports fallback-only routing and retains the configuration after a failed create", async () => {
    create.mockRejectedValueOnce(new Error("Could not create Router"));
    const { onCreated, onOpenChange } = mount();
    await configureSource("Fallback only");
    fireEvent.click(screen.getByRole("button", { name: "Remove Rule 1" }));
    expect(screen.getByText("No conditional routes. All incoming traffic will use the fallback below.")).toBeTruthy();
    await chooseGuardrail(fallbackRegion());
    fireEvent.click(screen.getByRole("button", { name: "Review configuration" }));
    const submit = screen.getByRole("button", { name: "Create Router", exact: true });
    await waitFor(() => expect(submit.matches(":disabled")).toBe(false));
    fireEvent.click(submit);
    expect(await screen.findByText("Could not create Router")).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(within(screen.getByRole("region", { name: "Review your Router" })).getByText("Fallback only")).toBeTruthy();
    fireEvent.click(submit);
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    const draft = create.mock.calls[1]![0].draft as RouterDraft;
    expect(draft.routes.map(r => r.kind)).toEqual(["fallback"]);
    expect(routingIssues(draft, true)).toEqual([]);
  });
});
