import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { getDeploymentCapabilities, getReleasedPolicies, type ReleasedPolicy } from "@/lib/controller-api";
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
vi.mock("@/lib/controller-api", async original => ({ ...(await original<typeof import("@/lib/controller-api")>()), getReleasedPolicies: vi.fn(), getDeploymentCapabilities: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

const usage = (guardrailVersion: string, serving: boolean) => ({ guardrailId: "bank", guardrailName: "Bank assistant", guardrailVersion, origin: "imported" as const,
  sourceId: "bank-uat", latest: serving, serving, enabledRuleIds: ["pattern/ipv4"], action: null, phases: ["input"] });
const network: ReleasedPolicy = { policyId: "local-network-addresses", name: "Network addresses", source: "built_in", serving: true, conflictingVersions: ["1.4.0"], versions: [
  { version: "2.0.0", contentDigest: "a".repeat(64), name: "Network addresses", description: "", rules: [{ id: "pattern/ipv4", name: "IPv4", action: "transform", phases: ["input"] }], usage: [usage("20261008-110000.000Z", true)] },
  { version: "1.4.0", contentDigest: "b".repeat(64), name: "Network addresses (legacy)", description: "", rules: [], usage: [usage("20261001-090000.000Z", false)] },
  { version: "1.4.0", contentDigest: "c".repeat(64), name: "Network addresses (legacy)", description: "", rules: [], usage: [usage("20260901-090000.000Z", false)] },
] };
const marker: ReleasedPolicy = { policyId: "policy-123", name: "Marker", source: "custom", serving: false, conflictingVersions: [], versions: [
  { version: "1", contentDigest: "d".repeat(64), name: "Marker", description: "", rules: [], usage: [usage("20261001-090000.000Z", false)] },
] };

function mount(authoringEnabled: boolean) {
  vi.mocked(getDeploymentCapabilities).mockResolvedValue({ authoringEnabled, packageExport: { available: false, sourceId: null }, packageImport: { available: true } });
  vi.mocked(getReleasedPolicies).mockResolvedValue({ items: [network, marker] });
  const library = vi.spyOn(api, "getPolicies").mockResolvedValue({ items: [], count: 0 });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PolicyLibraryPage /></QueryClientProvider>);
  return library;
}

describe("Policy Library where Policies are not authored", () => {
  it("lists released Policies by Policy ID without calling a Library API", async () => {
    const library = mount(false);
    expect(await screen.findByText("local-network-addresses")).toBeTruthy();
    expect(screen.getByText("policy-123")).toBeTruthy();
    expect(screen.getByText(`releasedPolicies.versionsInUse:${JSON.stringify({ count: 3 })}`)).toBeTruthy();
    expect(screen.getByLabelText(`releasedPolicies.conflict:${JSON.stringify({ versions: "1.4.0" })}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /policyLibrary.create|New Policy/ })).toBeNull();
    expect(library).not.toHaveBeenCalled();
  });

  it("opens one Policy with every released version, its rules and the Guardrail versions using it", async () => {
    mount(false);
    fireEvent.click(await screen.findByRole("button", { name: "Network addresses" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(`releasedPolicies.versionTitle:${JSON.stringify({ version: "2.0.0" })}`)).toBeTruthy();
    expect(within(sheet).getAllByText(`releasedPolicies.versionTitle:${JSON.stringify({ version: "1.4.0" })}`)).toHaveLength(2);
    expect(within(sheet).getAllByText(`releasedPolicies.nameAtVersion:${JSON.stringify({ name: "Network addresses (legacy)" })}`)).toHaveLength(2);
    expect(within(sheet).getByText("releasedPolicies.conflictDetail")).toBeTruthy();
    expect(within(sheet).getByText("20261008-110000.000Z")).toBeTruthy();
    expect(within(sheet).getAllByText(`releasedPolicies.importedFrom:${JSON.stringify({ source: "bank-uat" })}`).length).toBeGreaterThan(0);
  });

  it("keeps the editable Library where Policies are authored", async () => {
    const library = mount(true);
    await vi.waitFor(() => expect(library).toHaveBeenCalled());
    expect(getReleasedPolicies).not.toHaveBeenCalled();
  });
});
