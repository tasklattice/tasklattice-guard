import { queryOptions } from "@tanstack/react-query";

import { queryKeys } from "@/features/query-keys";
import { getGuardrails } from "@/lib/api";

export const guardrailQueries = {
  list: () => queryOptions({
    queryKey: queryKeys.guardrails,
    queryFn: getGuardrails,
    refetchInterval: 5000,
  }),
};
