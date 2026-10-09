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

function mount(view: "library" | "released") {
  vi.mocked(getReleasedPolicies).mockResolvedValue({ items: [network, marker] });
  const library = vi.spyOn(api, "getPolicies").mockResolvedValue({ items: [], count: 0 });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PolicyLibraryPage /></QueryClientProvider>);
  if (view === "released") {
    const tab = screen.getByRole("tab", { name: "releasedPolicies.releasedTab" });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
  }
  return library;
}

describe("Policies in released versions", () => {
  it("lists released Policies with the Library's cards and filters, read only", async () => {
    mount("released");
    const catalog = await screen.findByLabelText("policyLibrary.catalogLabel");
    expect(within(catalog).getAllByRole("article")).toHaveLength(2);
    expect(within(catalog).getByText("Network addresses")).toBeTruthy();
    expect(within(catalog).getByText("Marker")).toBeTruthy();
    // The declared protection tag still files a released definition under its directory.
    expect(within(catalog).getByText("protection.directories.privacy")).toBeTruthy();
    expect(within(catalog).getByText(`releasedPolicies.versionsInUse:${JSON.stringify({ count: 3 })}`)).toBeTruthy();
    expect(screen.getByLabelText("policyLibrary.filters")).toBeTruthy();
    expect(screen.getByText("releasedPolicies.description")).toBeTruthy();
    for (const name of ["policyLibrary.newPolicy", "policyStudio.importPolicy"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByRole("button", { name: /policyLibrary.exportPolicyAria|policyLibrary.deletePolicyAria/ })).toBeNull();
  });

  it("opens the Library's detail, read only, with every released version and the Guardrail versions using it", async () => {
    mount("released");
    const card = (await screen.findByText("Network addresses")).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: /policyLibrary.inspectPolicy/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("IPv4")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "policyLibrary.editPolicy" })).toBeNull();
    fireEvent.mouseDown(within(sheet).getByRole("tab", { name: /releasedPolicies.tab/ }));
    fireEvent.click(within(sheet).getByRole("tab", { name: /releasedPolicies.tab/ }));
    expect(await within(sheet).findByText(`releasedPolicies.versionTitle:${JSON.stringify({ version: "2.0.0" })}`)).toBeTruthy();
    expect(within(sheet).getAllByText(`releasedPolicies.versionTitle:${JSON.stringify({ version: "1.4.0" })}`)).toHaveLength(2);
    expect(within(sheet).getAllByText(`releasedPolicies.nameAtVersion:${JSON.stringify({ name: "Network addresses (legacy)" })}`)).toHaveLength(2);
    expect(within(sheet).getByText("releasedPolicies.conflictDetail")).toBeTruthy();
    expect(within(sheet).getByText("20261008-110000.000Z")).toBeTruthy();
    expect(within(sheet).getAllByText(`releasedPolicies.importedFrom:${JSON.stringify({ source: "bank-uat" })}`).length).toBeGreaterThan(0);
  });

  it("says a released custom Policy keeps test names, not inputs", async () => {
    mount("released");
    const card = (await screen.findByText("Marker")).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: /policyLibrary.inspectPolicy/ }));
    const sheet = await screen.findByRole("dialog");
    const tests = within(sheet).getByRole("tab", { name: /policyLibrary.tabs.testCases/ });
    fireEvent.mouseDown(tests);
    fireEvent.click(tests);
    fireEvent.click(await within(sheet).findByText("Blocks the marker"));
    expect(within(sheet).getByText("releasedPolicies.testInputNotReleased")).toBeTruthy();
  });

  it("opens on the editable Library and reads released definitions only in their own view", async () => {
    const library = mount("library");
    await vi.waitFor(() => expect(library).toHaveBeenCalled());
    expect(screen.getByRole("tab", { name: "releasedPolicies.libraryTab" }).getAttribute("aria-selected")).toBe("true");
    expect(getReleasedPolicies).not.toHaveBeenCalled();
  });
});
