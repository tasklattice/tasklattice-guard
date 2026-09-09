import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "@/features/query-keys";
import {
  getGuardrails,
  getMetrics,
  metricWindowMilliseconds,
  type MetricWindow,
} from "@/lib/api";
import { listRuntimeEvents } from "@/lib/controller-api";

export type DashboardFilters = {
  guardrailId?: string;
  window: MetricWindow;
};

export function useGuardrailsDashboard(filters: DashboardFilters) {
  const metrics = useQuery({
    queryKey: queryKeys.metricsScope(filters),
    queryFn: ({ signal }) => getMetrics(filters, signal),
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
  const events = useQuery({
    queryKey: queryKeys.runtimeEventsScope({ ...filters, limit: 50 }),
    queryFn: ({ signal }) => listRuntimeEvents(50, {
      guardrailId: filters.guardrailId,
      since: new Date(Date.now() - metricWindowMilliseconds(filters.window)).toISOString(),
    }, signal),
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
  });
  const guardrails = useQuery({
    queryKey: queryKeys.guardrails,
    queryFn: getGuardrails,
  });
  return {
    metrics,
    events,
    guardrails,
    error: metrics.error ?? events.error ?? guardrails.error,
  };
}

export function getMetricInterval(window: MetricWindow) {
  const intervals: Record<MetricWindow, "1m" | "15m" | "1h" | "6h" | "1d"> = {
    "1h": "1m",
    "24h": "15m",
    "7d": "1h",
    "15d": "6h",
    "30d": "1d",
  };
  return intervals[window];
}
