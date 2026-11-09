import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { getGuardrailRequestRates } from "@/lib/observability-api";
import { guardrailRequestRatesQuery } from "./guardrail-request-rates";
vi.mock("@/lib/observability-api", () => ({ getGuardrailRequestRates: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
function Consumer() { const query = useQuery(guardrailRequestRatesQuery()); return <span>{query.status}</span>; }
it("shares one request and refreshes only after 60 seconds, stopping after unmount", async () => {
  vi.useFakeTimers();
  vi.mocked(getGuardrailRequestRates).mockResolvedValue({ byGuardrail: {}, zeroPoints: [] });
  const client = new QueryClient();
  const view = render(<QueryClientProvider client={client}><Consumer /><Consumer /></QueryClientProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(getGuardrailRequestRates).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
  expect(getGuardrailRequestRates).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(getGuardrailRequestRates).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(getGuardrailRequestRates).toHaveBeenCalledTimes(2);
  client.clear();
});
