import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdvancedPlayground } from "./advanced-playground";
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/controller-api", () => ({ requestController: api.request }));
vi.mock("@/components/traffic-routing/form", () => ({
  useRoutingText: () => (_zh: string, en: string) => en,
}));
vi.mock("@/lib/traffic-routing-api", () => ({
  trafficRouterKeys: { all: ["routers"] },
  listTrafficRouters: async () => ({
    items: [
      {
        id: "router",
        name: "Partner router",
        activeRevision: 3,
        draftRevision: 4,
        endpointIds: ["endpoint"],
      },
    ],
  }),
}));
vi.mock("@/lib/endpoints-api", () => ({
  getEndpoints: async () => ({
    items: [
      { id: "endpoint", name: "Support API", protocol: "http" },
      { id: "second", name: "Second API", protocol: "litellm" },
    ],
  }),
}));
vi.mock("./path-test-controls", () => ({
  PathTestSelect: ({ label, value, options, onChange, disabled }: any) => (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    >
      {options.map((o: any) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AdvancedPlayground active guardrails={[]} />
    </QueryClientProvider>,
  );
}
const success = {
  target: "router",
  source: "runner",
  status: 200,
  durationMs: 10,
  callId: "c",
  body: {
    simulation: true,
    assignment: { guardrailId: "g1", guardrailVersion: "v3" },
    runnerId: "r1",
  },
};
async function ready() {
  mount();
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Test routing",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
}
function choose(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function tab(name: string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), {
    button: 0,
    ctrlKey: false,
  });
}
describe("advanced request workbench", () => {
  it("sends enabled GUI headers and keeps only the current result in the main workspace", async () => {
    api.request.mockResolvedValue(success);
    await ready();
    choose("Header 2 value", "customer");
    fireEvent.click(screen.getByLabelText("Enable header 1"));
    fireEvent.click(screen.getByRole("button", { name: "Test routing" }));
    await screen.findByText("Routed to g1 · v3");
    const sent = JSON.parse(api.request.mock.calls[0][1].body);
    expect(sent).toMatchObject({
      target: "router",
      targetId: "router",
      expectedRevision: 3,
      endpointId: "endpoint",
      action: "simulate",
    });
    expect(sent.request).toContain("X-Channel: customer");
    expect(sent.request).not.toContain("Content-Type");
    fireEvent.click(screen.getByRole("button", { name: "Test routing" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "History (2)" })).toBeTruthy(),
    );
    expect(document.querySelectorAll("article")).toHaveLength(1);
    choose("Test path", "endpoint");
    expect(screen.getByText(/Partner router · Published r3/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "History (2)" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Restore request and result" })[0],
    );
    expect(
      (screen.getByLabelText("Test path") as HTMLSelectElement).value,
    ).toBe("router");
    expect(api.request).toHaveBeenCalledTimes(2);
  });
  it("keeps Endpoint documents separate and shows authentication failures without storing keys", async () => {
    api.request.mockResolvedValue({
      ...success,
      target: "endpoint",
      status: 401,
      body: { detail: "Endpoint credential is invalid." },
    });
    await ready();
    choose("Test path", "endpoint");
    tab("Body");
    choose("Request body", '{"texts":["edited"]}');
    choose("Endpoint", "second");
    expect(
      (screen.getByLabelText("Request URL") as HTMLInputElement).value,
    ).toContain("/second/beta/litellm");
    expect(
      (screen.getByLabelText("Request body") as HTMLTextAreaElement).value,
    ).toContain('"input_type"');
    choose("Endpoint", "endpoint");
    expect(
      (screen.getByLabelText("Request body") as HTMLTextAreaElement).value,
    ).toContain("edited");
    tab("Auth");
    choose("Endpoint API key", "hidden-secret");
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await screen.findByText("HTTP 401");
    expect(screen.getByText("Endpoint credential is invalid.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "History (1)" }));
    expect(screen.getByRole("dialog").textContent).not.toContain(
      "hidden-secret",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Restore request and result" }),
    );
    expect(
      (screen.getByLabelText("Endpoint API key") as HTMLInputElement).value,
    ).toBe("");
  });
  it("validates an import before replacing the GUI and restricts drafts to matching", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Import HTTP/cURL" }));
    choose("HTTP request or curl", "broken");
    fireEvent.click(screen.getByRole("button", { name: "Import and replace" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    choose(
      "HTTP request or curl",
      "curl https://example.com/chat -H 'X-Channel: imported' -d hello",
    );
    fireEvent.click(screen.getByRole("button", { name: "Import and replace" }));
    expect(
      (screen.getByLabelText("Request URL") as HTMLInputElement).value,
    ).toBe("/chat");
    expect(
      (screen.getByLabelText("Header 1 value") as HTMLInputElement).value,
    ).toBe("imported");
    choose("Configuration", "draft");
    expect(
      screen.queryByRole("option", { name: "Route and execute" }),
    ).toBeNull();
    expect(api.request).not.toHaveBeenCalled();
  });
});
