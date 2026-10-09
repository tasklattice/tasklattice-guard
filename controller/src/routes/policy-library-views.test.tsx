import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import type { Policy } from "@/lib/api";
import { getReleasedPolicies, type ReleasedPolicy } from "@/lib/controller-api";
import { PolicyLibraryPage } from "./policy-library";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key}:${JSON.stringify(values)}` : key, i18n: { language: "en", exists: () => false } }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to?: string }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(), useSearch: () => ({}),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));
vi.mock("@/lib/controller-api", async original => ({ ...(await original<typeof import("@/lib/controller-api")>()), getReleasedPolicies: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

function definition(id: string, version: string, name: string, extra: Partial<Policy> = {}): Policy {
  return { implementation: "rules", id, name, description: `${name} description`, source: "built_in", version,
    tags: [{ id: "protection:privacy", namespace: "protection", value: "privacy", label: "Privacy", source: "declared" }],
    parameters: [], rails: ["input"], effects: ["transform"], detectors: ["pattern/regex"],
    rules: [{ id: "pattern/ipv4", name: "IPv4", description: "", detector: { ref: "pattern/regex", version: "1" }, effect: "transform", risk_severity: null, rails: ["input"] }] as Policy["rules"],
    test_cases: [], test_count: 0, safety_level: "balanced", output_delivery: "window_buffered", ...extra };
}
const usage = (guardrailVersion: string, serving: boolean) => ({ guardrailId: "bank", guardrailName: "Bank assistant", guardrailVersion, origin: "imported" as const,
  sourceId: "bank-uat", latest: serving, serving, enabledRuleIds: ["pattern/ipv4"], action: null, phases: ["input"] });
const network: ReleasedPolicy = { policyId: "local-network-addresses", name: "Network addresses", source: "built_in", serving: true, conflictingVersions: ["1.4.0"], versions: [
  { version: "2.0.0", contentDigest: "a".repeat(64), name: "Network addresses", definition: definition("local-network-addresses", "2.0.0", "Network addresses"), usage: [usage("20261008-110000.000Z", true)] },
  { version: "1.4.0", contentDigest: "b".repeat(64), name: "Network addresses (legacy)", definition: definition("local-network-addresses", "1.4.0", "Network addresses (legacy)"), usage: [usage("20261001-090000.000Z", false)] },
  { version: "1.4.0", contentDigest: "c".repeat(64), name: "Network addresses (legacy)", definition: definition("local-network-addresses", "1.4.0", "Network addresses (legacy)"), usage: [usage("20260901-090000.000Z", false)] },
] };
const marker: ReleasedPolicy = { policyId: "policy-123", name: "Marker", source: "custom", serving: false, conflictingVersions: [], versions: [
  { version: "1", contentDigest: "d".repeat(64), name: "Marker", usage: [usage("20261001-090000.000Z", false)],
    definition: definition("policy-123", "1", "Marker", { implementation: "nemo_native", source: "custom", tags: [],
      test_cases: [{ id: "release/1", name: "Blocks the marker", description: "", phase: "input", content: "", expected_decision: "block", covered_rule_ids: [], group: "Policy validation", kind: "scenario", required: true, parameter_names: [] }] as Policy["test_cases"], test_count: 1 }) },
] };

const libraryNetwork = definition("local-network-addresses", "2.1.0", "Network addresses");
const unused = definition("local-keywords", "1.0.0", "Keywords");

function mount() {
  vi.mocked(getReleasedPolicies).mockResolvedValue({ items: [network, marker] });
  const library = vi.spyOn(api, "getPolicies").mockResolvedValue({ items: [libraryNetwork, unused], count: 2 });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PolicyLibraryPage /></QueryClientProvider>);
  return library;
}
const cards = async () => within(await screen.findByLabelText("policyLibrary.catalogLabel")).queryAllByRole("article");

describe("One Policy list with a Usage filter", () => {
  it("lists the Library and Policies that exist here only in released versions, without views to switch", async () => {
    mount();
    expect(await cards()).toHaveLength(3);
    expect(screen.queryByRole("tab", { name: /releasedPolicies/ })).toBeNull();
    // A Library Policy shows the Library's definition; its releases are summarized on the card.
    const networkCard = screen.getByText("Network addresses").closest("article")!;
    expect(within(networkCard).getByText("v2.1.0")).toBeTruthy();
    expect(within(networkCard).getByText(`releasedPolicies.versionsInUse:${JSON.stringify({ count: 3 })}`)).toBeTruthy();
    // A released-only custom Policy can be inspected, not exported or deleted.
    const markerCard = screen.getByText("Marker").closest("article")!;
    expect(within(markerCard).queryByRole("button", { name: /policyLibrary.exportPolicyAria|policyLibrary.deletePolicyAria/ })).toBeNull();
    for (const name of ["policyLibrary.newPolicy", "policyStudio.importPolicy"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  });

  it("filters by whether a released Guardrail version uses the Policy", async () => {
    mount();
    await cards();
    const [desktop] = screen.getAllByLabelText("policyLibrary.filters");
    expect(within(desktop as HTMLElement).getByText(/policyLibrary.tagNamespaces.usage/)).toBeTruthy();
    fireEvent.click(within(desktop as HTMLElement).getByRole("checkbox", { name: /policyLibrary.usageLabels.used/ }));
    expect((await cards()).map((card) => within(card).getByRole("heading").textContent)).toEqual(["Network addresses", "Marker"]);
    fireEvent.click(within(desktop as HTMLElement).getByRole("checkbox", { name: /policyLibrary.usageLabels.used/ }));
    fireEvent.click(within(desktop as HTMLElement).getByRole("checkbox", { name: /policyLibrary.usageLabels.unused/ }));
    expect((await cards()).map((card) => within(card).getByRole("heading").textContent)).toEqual(["Keywords"]);
  });

  it("opens a used Policy with every released version and the Guardrail versions using it", async () => {
    mount();
    const card = (await screen.findByText("Network addresses")).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: /policyLibrary.inspectPolicy/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("IPv4")).toBeTruthy();
    expect(within(sheet).queryByText("releasedPolicies.notInLibrary")).toBeNull();
    fireEvent.mouseDown(within(sheet).getByRole("tab", { name: /releasedPolicies.tab/ }));
    fireEvent.click(within(sheet).getByRole("tab", { name: /releasedPolicies.tab/ }));
    expect(await within(sheet).findByText(`releasedPolicies.versionTitle:${JSON.stringify({ version: "2.0.0" })}`)).toBeTruthy();
    expect(within(sheet).getAllByText(`releasedPolicies.versionTitle:${JSON.stringify({ version: "1.4.0" })}`)).toHaveLength(2);
    expect(within(sheet).getAllByText(`releasedPolicies.nameAtVersion:${JSON.stringify({ name: "Network addresses (legacy)" })}`)).toHaveLength(2);
    expect(within(sheet).getByText("releasedPolicies.conflictDetail")).toBeTruthy();
    expect(within(sheet).getByText("20261008-110000.000Z")).toBeTruthy();
    expect(within(sheet).getAllByText(`releasedPolicies.importedFrom:${JSON.stringify({ source: "bank-uat" })}`).length).toBeGreaterThan(0);
  });

  it("marks a released-only Policy read only and says it keeps test names, not inputs", async () => {
    mount();
    const card = (await screen.findByText("Marker")).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: /policyLibrary.inspectPolicy/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("releasedPolicies.notInLibrary")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "policyLibrary.editPolicy" })).toBeNull();
    const tests = within(sheet).getByRole("tab", { name: /policyLibrary.tabs.testCases/ });
    fireEvent.mouseDown(tests);
    fireEvent.click(tests);
    fireEvent.click(await within(sheet).findByText("Blocks the marker"));
    expect(within(sheet).getByText("releasedPolicies.testInputNotReleased")).toBeTruthy();
  });
});
