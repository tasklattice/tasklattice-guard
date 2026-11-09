import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Policy } from "@/lib/api";
import { PolicyLibraryPage } from "./policy-library";

const mocks = vi.hoisted(() => ({ policies: vi.fn(), profiles: vi.fn(), navigate: vi.fn(), search: {} as Record<string, unknown> }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate, useSearch: () => mocks.search }));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => String(values?.defaultValue ?? key), i18n: { language: "en" } }),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "user" } }) }));
vi.mock("@/lib/api", async original => ({
  ...await original<typeof import("@/lib/api")>(),
  getPolicies: () => mocks.policies(),
  getGuardrailProfiles: () => mocks.profiles(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const policy = (id: string, name: string): Policy => ({
  id, version: "1.0.0", name, description: `${name} description`, source: "built_in", implementation: "rules",
  tags: [], parameters: [], rails: ["input"], effects: ["block"], detectors: [], rules: [], test_cases: [], test_count: 0,
  safety_level: "balanced", output_delivery: "full_buffered",
} as Policy);

// Profiles are platform configuration. They seed Guardrail drafts elsewhere and
// must not appear as browsable entries in the Policy catalog.
const profile = (id: string, name: string) => ({
  id, version: "1.0.0", name, description: "", industry: "banking", jurisdictions: ["sg"], policies: [], bindings: [],
  suggestedTopics: [], optionalPolicyIds: [], limitations: [],
});

beforeEach(() => {
  mocks.search = {};
  mocks.policies.mockResolvedValue({ items: [policy("payment-data", "Payment Data"), policy("contact-data", "Contact Data")], count: 2 });
  mocks.profiles.mockResolvedValue({ items: [profile("sg-bank", "Singapore Bank"), profile("default", "Default")], count: 2 });
});

describe("Policy catalog scope", () => {
  it("lists Policies only and never surfaces platform Profiles as entries", async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PolicyLibraryPage /></QueryClientProvider>);

    const catalog = await screen.findByLabelText("policyLibrary.catalogLabel");
    expect(within(catalog).getAllByRole("article")).toHaveLength(2);
    expect(within(catalog).getByText("Payment Data")).toBeTruthy();
    expect(within(catalog).getByText("Contact Data")).toBeTruthy();
    expect(screen.queryByText("Singapore Bank")).toBeNull();
    expect(screen.queryByText("Default")).toBeNull();
    expect(mocks.profiles).not.toHaveBeenCalled();
  });
});
