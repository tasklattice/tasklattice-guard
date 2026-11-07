import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import type { Policy } from "@/lib/api";
import { PolicyLibraryPage } from "./policy-library";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key}:${JSON.stringify(values)}` : key, i18n: { language: "en", exists: () => false } }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to?: string }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(), useSearch: () => ({}),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "user" } }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function definition(id: string, version: string, name: string, extra: Partial<Policy> = {}): Policy {
  return { deletable: true, implementation: "nemo_native", id, name, description: `${name} description`, source: "custom", version, tags: [],
    parameters: [], rails: ["input"], effects: ["block"], detectors: [], rules: [], test_cases: [], test_count: 0,
    safety_level: "balanced", output_delivery: "window_buffered", ...extra };
}
const local = definition("policy-local", "3", "Local marker", { origin: "local", source_id: null });
const imported = definition("policy-studio", "1", "Studio marker", { origin: "imported", source_id: "bank-uat" });

function mount(items = [local, imported]) {
  vi.spyOn(api, "getPolicies").mockResolvedValue({ items, count: items.length });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PolicyLibraryPage /></QueryClientProvider>);
}

describe("Policy Library", () => {
  it("lists this environment's Policies only, with no usage or traffic state", async () => {
    mount();
    const catalog = await screen.findByLabelText("policyLibrary.catalogLabel");
    expect(within(catalog).getAllByRole("article")).toHaveLength(2);
    expect(screen.queryByText(/releasedPolicies|usageLabels|tagNamespaces.usage/)).toBeNull();
  });

  it("keeps import provenance out of the card and offers maintenance to administrators", async () => {
    mount();
    const card = (await screen.findByText("Studio marker")).closest("article")!;
    expect(within(card).queryByText(/policyLibrary.importedFrom/)).toBeNull();
    expect(within(card).getByRole("button", { name: /policyLibrary.exportPolicyAria/ })).toBeTruthy();
    expect(within(card).getByRole("button", { name: /policyLibrary.deletePolicyAria/ })).toBeTruthy();
    const localCard = screen.getByText("Local marker").closest("article")!;
    expect(within(localCard).getByRole("button", { name: /policyLibrary.deletePolicyAria/ })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: /policyLibrary.inspectPolicy/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).queryByText(/policyLibrary.importedReadOnly/)).toBeNull();
    expect(within(sheet).getByRole("button", { name: "policyLibrary.editPolicy" })).toBeTruthy();
    expect(within(sheet).queryByRole("tab", { name: /releasedPolicies/ })).toBeNull();
  });
  it("deletes a Rules Policy from its inspector and refreshes the catalog", async () => {
    const rules = definition("rules-draft", "0", "Rules draft", { implementation: "rules" });
    const remove = vi.spyOn(api, "deletePolicy").mockResolvedValue(undefined);
    mount([rules]);
    const card = (await screen.findByText(rules.name)).closest("article")!;
    expect(within(card).getByRole("button", { name: /policyLibrary.deletePolicyAria/ })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "policyLibrary.inspectPolicy" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "policyLibrary.deleteAction" }));
    expect(remove).not.toHaveBeenCalled();
    vi.mocked(api.getPolicies).mockResolvedValue({ items: [], count: 0 });
    fireEvent.click(screen.getByRole("button", { name: "policyLibrary.deleteConfirm" }));
    await waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith(rules.id));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText(rules.name)).toBeNull();
  });

  it("keeps a referenced Rules Policy visible after deletion fails and allows cancel", async () => {
    const rules = definition("in-use", "r1", "Referenced Rules", { implementation: "rules" });
    vi.spyOn(api, "deletePolicy").mockRejectedValue(new Error("Policy is still referenced by Guardrail drafts: Default."));
    mount([rules]);
    const card = (await screen.findByText(rules.name)).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: /policyLibrary.deletePolicyAria/ }));
    fireEvent.click(screen.getByRole("button", { name: "policyLibrary.deleteConfirm" }));
    await screen.findByText("Policy is still referenced by Guardrail drafts: Default.");
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(rules.name)).toBeTruthy();
  });

});
