import { queryOptions, type QueryFilters } from "@tanstack/react-query";
import { getEndpoints } from "@/lib/api";
import { queryKeys } from "./query-keys";

// Refresh list totals across tenant-scoped navigation without overwriting
// detail data just returned by a settings or credential mutation.
export const endpointListQueryFilters: QueryFilters = {
  queryKey: queryKeys.endpoints,
  predicate: query => query.queryKey.length === queryKeys.endpoints.length
    || query.queryKey[queryKeys.endpoints.length] === "tenant",
};

export const endpointsQueryOptions = () => queryOptions({
  queryKey: queryKeys.endpoints,
  queryFn: getEndpoints,
  refetchInterval: 30_000,
});
