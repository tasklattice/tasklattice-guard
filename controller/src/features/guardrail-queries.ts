import { queryOptions } from "@tanstack/react-query";

import { queryKeys } from "@/features/query-keys";
import { getGuardrails } from "@/lib/api";

export const guardrailQueries = {
  list: () => queryOptions({
    queryKey: queryKeys.guardrails,
    queryFn: getGuardrails,
    select: (collection) => ({
      ...collection,
      items: [...collection.items].sort(
        (left, right) => Number(right.is_default) - Number(left.is_default),
      ),
    }),
  }),
};
