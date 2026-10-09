import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlaygroundPage } from "./playground";

const api = vi.hoisted(() => ({ models: vi.fn(), guardrails: vi.fn(), draftPreview: vi.fn() }));
const session = vi.hoisted(() => ({ role: "operator" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: session.role } }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/api", () => ({
  getGuardrails: api.guardrails,
  getPlaygroundModels: api.models,
  getGuardrailVersions: async () => ({ items: [{ version: "v1" }] }),
  preparePlaygroundDraftPreview: api.draftPreview,
  createPlaygroundInteraction: vi.fn(),
}));
vi.mock("@/components/playground/probe-conversation-panel", () => ({
  ProbeConversationPanel: () => <div>Simple conversation</div>,
}));
vi.mock("@/components/playground/probe-inspection-drawer", () => ({ ProbeInspectionDrawer: () => null }));
vi.mock("@/components/playground/advanced-playground", () => ({
  AdvancedPlayground: () => <label>Request body<input defaultValue="" /></label>,
}));

const clients: QueryClient[] = [];
const models = { items: [{ id: "model", provider: "test", name: "Test model", icon: "" }] };
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}><PlaygroundPage /></QueryClientProvider>);
}
beforeEach(() => {
  window.history.replaceState({}, "", "/playground");
  api.guardrails.mockResolvedValue({ items: [{ id: "guard", name: "Guard", published_current: "v1", published_version_count: 1 }] });
  api.models.mockResolvedValue(models);
});
afterEach(() => {
  session.role = "operator";
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});

it("hides mode tabs while the model connection loads, then renders the actual workspace", async () => {
  let resolve!: (value: typeof models) => void;
  api.models.mockReturnValue(new Promise(done => { resolve = done; }));
  const { container } = mount();
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(container.querySelector('.cds--skeleton__placeholder')).not.toBeNull();
  await act(async () => resolve(models));
  expect(await screen.findByRole("tablist", { name: "playground.modeLabel" })).toBeTruthy();
  expect(await screen.findByText("Simple conversation")).toBeTruthy();
});

it.each(["/playground", "/playground?mode=advanced"])("shows setup guidance without mode tabs when no model connection is available at %s", async (url) => {
  window.history.replaceState({}, "", url);
  api.models.mockResolvedValue({ items: [] });
  mount();
  expect(await screen.findByText("playground.controllerUnavailableTitle")).toBeTruthy();
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.queryByLabelText("Request body")).toBeNull();
});

it("renders a connection error instead of an empty page or mode switch", async () => {
  api.models.mockRejectedValue(new Error("Model connection unavailable"));
  mount();
  expect(await screen.findByText("Model connection unavailable")).toBeTruthy();
  expect(screen.queryByRole("tablist")).toBeNull();
});

it("switches actual panels and keeps the advanced request when returning to it", async () => {
  mount();
  const advanced = await screen.findByRole("tab", { name: "playground.advancedMode" });
  fireEvent.click(advanced);
  expect(window.location.search).toContain("mode=advanced");
  fireEvent.change(screen.getByLabelText("Request body"), { target: { value: "Keep this request" } });
  fireEvent.click(screen.getByRole("tab", { name: "playground.simpleMode" }));
  await waitFor(() => expect(screen.queryByRole("tabpanel", { name: "playground.advancedMode" })).toBeNull());
  expect(screen.getByRole("tabpanel", { name: "playground.simpleMode" }).textContent).toContain("Simple conversation");
  fireEvent.click(screen.getByRole("tab", { name: "playground.advancedMode" }));
  expect((screen.getByLabelText("Request body") as HTMLInputElement).value).toBe("Keep this request");
});

it("opens a ready advanced deep link without selecting Simple mode first", async () => {
  window.history.replaceState({}, "", "/playground?mode=advanced");
  mount();
  expect(await screen.findByLabelText("Request body")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "playground.advancedMode" }).getAttribute("aria-selected")).toBe("true");
});

