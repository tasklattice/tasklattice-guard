import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { BillingPage } from "./billing";
import { getGuardrails } from "@/lib/api";
import type { Guardrail } from "@/lib/api";
vi.mock("@/lib/api", () => ({ getGuardrails: vi.fn() }));
vi.mock("@/components/guardrail-usage-costs", () => ({ GuardrailUsageCosts: ({ guardrailId, guardrailFilter }: { guardrailId: string; guardrailFilter?: ReactNode }) => <div>{guardrailFilter}<div>Costs for {guardrailId}</div></div> }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const guards = [{ id: "one", name: "First Guardrail" }, { id: "two", name: "Second Guardrail" }] as Guardrail[];
function show(guardrailId?: string) {
  const onGuardrailChange = vi.fn();
  const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><BillingPage guardrailId={guardrailId} onGuardrailChange={onGuardrailChange} /></QueryClientProvider>);
  return { ...view, onGuardrailChange };
}
it("uses the selected Guardrail from the URL and lets the user select another", async () => {
  vi.mocked(getGuardrails).mockResolvedValue({ items: guards, count: 2 });
  const { onGuardrailChange } = show("two");
  expect(await screen.findByText("Costs for two")).toBeTruthy();
  fireEvent.click(screen.getByRole("combobox", { name: "modelPricing.selectGuardrail" }));
  fireEvent.click(screen.getByRole("option", { name: "First Guardrail" }));
  expect(onGuardrailChange).toHaveBeenCalledWith("one");
});
it("defaults to the first available Guardrail", async () => {
  vi.mocked(getGuardrails).mockResolvedValue({ items: guards, count: 2 });
  show();
  expect(await screen.findByText("Costs for one")).toBeTruthy();
});
it("does not silently show another bill when a bookmarked Guardrail is unavailable", async () => {
  vi.mocked(getGuardrails).mockResolvedValue({ items: guards, count: 2 });
  show("deleted");
  expect(await screen.findByText("modelPricing.missingGuardrail")).toBeTruthy();
  expect(screen.queryByText(/^Costs for/)).toBeNull();
});
it("explains when there are no Guardrails", async () => {
  vi.mocked(getGuardrails).mockResolvedValue({ items: [], count: 0 });
  show();
  expect(await screen.findByText("modelPricing.noGuardrails")).toBeTruthy();
  expect(screen.queryByRole("combobox")).toBeNull();
});
it("recovers from a failed list request", async () => {
  vi.mocked(getGuardrails).mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ items: guards, count: 2 });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "common.retry" }));
  expect(await screen.findByText("Costs for one")).toBeTruthy();
});
