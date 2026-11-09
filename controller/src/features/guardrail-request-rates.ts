import { queryOptions } from "@tanstack/react-query";
import { getGuardrailRequestRates } from "@/lib/observability-api";
import { queryKeys } from "./query-keys";

export const guardrailRequestRatesQuery = () => queryOptions({
  queryKey: [...queryKeys.metrics, "guardrail-request-rates", "1h"],
  queryFn: ({ signal }) => getGuardrailRequestRates(signal),
  staleTime: 60_000,
  refetchInterval: 60_000,
  refetchOnWindowFocus: false,
  retry: false,
});
