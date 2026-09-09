import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { protectionEn } from "../protection-i18n";
import type { Policy } from "@/lib/api";
import { PolicyLibraryPage } from "./policy-library";

vi.mock("@/components/policy-studio", () => ({ PolicyStudioSheet: () => null }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "member" } }) }));
const routing = vi.hoisted(() => ({ search: {} as { policy?: string; version?: string }, navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => routing.navigate, useSearch: () => routing.search, Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key.startsWith("protection.") ? key.slice(11).split(".").reduce((value: unknown, part) => (value as Record<string, unknown>)?.[part], protectionEn) ?? key : key }) }));
const api = vi.hoisted(() => ({ getPolicies: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({ ...await original<typeof import("@/lib/api")>(), getPolicies: api.getPolicies }));

const current: Policy = {
  id: "passport", name: "Passport identifiers", description: "Contextual passport checks", source: "built_in", version: "2",
  implementation: "rules", tags: [], parameters: [], rails: ["input", "output"], rules: [], test_cases: [], test_count: 4,
  effects: ["redact"], forms: ["regex"], safety_level: "balanced", output_delivery: "full_buffered",
  protection: { directory: "privacy", execution: "local", modelCapabilities: [], requiredContext: [], outputStreaming: "complete_response", limitations: [] },
};
afterEach(cleanup);
beforeEach(() => { routing.search = {}; routing.navigate.mockReset(); });

describe("focused protection library", () => {
  it("opens the pinned snapshot instead of the current catalog version", async () => {
    const old = { ...current, version: "1", name: "Published passport version one" };
    routing.search = { policy: current.id, version: "1" };
    api.getPolicies.mockResolvedValue({ items: [{ ...current, published_versions: [old] }], count: 1 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><PolicyLibraryPage /></QueryClientProvider>);
    const inspector = await screen.findByRole("dialog");
    expect(within(inspector).getByRole("heading", { name: old.name })).toBeTruthy();
    expect(within(inspector).queryByRole("heading", { name: current.name })).toBeNull();
  });

  it("reports unavailable pinned versions without opening another version and offers recovery", async () => {
    routing.search = { policy: current.id, version: "missing" };
    api.getPolicies.mockResolvedValue({ items: [current], count: 1 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><PolicyLibraryPage /></QueryClientProvider>);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No other version has been substituted");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "common.close" }));
    expect(routing.navigate).toHaveBeenCalledWith({ to: "/policy-library", search: { policy: undefined, version: undefined }, replace: true });
  });

  it("shows the complete map and respects an empty directory", async () => {
    api.getPolicies.mockResolvedValue({ items: [current, { ...current, id: "mixed", name: "Mixed collection" }], count: 2 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><PolicyLibraryPage /></QueryClientProvider>);
    expect(await screen.findByRole("heading", { name: current.name })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Mixed collection" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /Answer reliability/ })[0]!);
    expect(screen.queryByRole("heading", { name: current.name })).toBeNull();
    expect(screen.getByText("policyLibrary.noCatalogResults")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /policyLibrary.clearFilters/ })[0]!);
    expect(screen.getByRole("heading", { name: "Mixed collection" })).toBeTruthy();
  });
});
