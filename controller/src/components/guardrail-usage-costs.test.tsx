import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { GuardrailUsageCosts } from "./guardrail-usage-costs";
import type { GuardrailCostView } from "../../shared/model-pricing";
import { getGuardrailCosts } from "@/lib/model-pricing-api";
vi.mock("@/lib/model-pricing-api", () => ({ getGuardrailCosts: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <a href="/settings/models?tab=pricing">{children}</a> }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
afterEach(cleanup);
const base: GuardrailCostView = { since: "2026-10-01T00:00:00Z", until: "2026-10-14T00:00:00Z", meteringSince: "2026-10-01T00:00:00Z", updatedAt: null, calls: 2, inputTokens: 0, outputTokens: 0, unknownUsage: 2, unpriced: 2, totals: [], trend: [], models: [{ modelId: "small", model: "small-guard", provider: "local", currency: null, calls: 2, inputTokens: 0, outputTokens: 0, unknownUsage: 2, cost: null, unpriced: 2 }] };
function show(data: GuardrailCostView) {
  vi.mocked(getGuardrailCosts).mockResolvedValue(data);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><GuardrailUsageCosts guardrailId="guard" /></QueryClientProvider>);
}
describe("Guardrail cost state semantics", () => {
  it("shows unknown amounts and tokens as unaccounted, never zero", async () => {
    show(base);
    const table = await screen.findByRole("table");
    expect(within(table).getByText("modelPricing.unpriced")).toBeTruthy();
    expect(within(table).getAllByText("—")).toHaveLength(2);
    expect(within(table).queryByText(/USD 0/)).toBeNull();
    expect(screen.getByText("modelPricing.incompleteHint")).toBeTruthy();
  });
  it("keeps an empty period distinct from unaccounted calls", async () => {
    show({ ...base, calls: 0, unpriced: 0, unknownUsage: 0, models: [] });
    expect(await screen.findByText("modelPricing.empty")).toBeTruthy();
    expect(screen.queryByText("modelPricing.incompleteHint")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
