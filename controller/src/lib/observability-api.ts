import * as controllerApi from "@/lib/controller-api";
import {
  arrayOfRecords,
  arrayOfStrings,
  enumValue,
  isTimedOut,
  normalizeOutcome,
  runtimeFindings,
  runtimeTraceSteps,
  stringValue,
} from "@/lib/controller-api-mappers";
import type {
  Collection,
  GuardrailFindingPage,
  Metrics,
  MetricWindow,
  RuntimeLogInteraction,
} from "@/lib/api-types";

export function metricWindowMilliseconds(window: MetricWindow): number {
  return {
    "1h": 60 * 60 * 1_000,
    "24h": 24 * 60 * 60 * 1_000,
    "7d": 7 * 24 * 60 * 60 * 1_000,
    "15d": 15 * 24 * 60 * 60 * 1_000,
    "30d": 30 * 24 * 60 * 60 * 1_000,
  }[window];
}

export const getGuardrailFindings = async (
  guardrailId: string, window: MetricWindow, limit = 100, cursor?: string, signal?: AbortSignal, severity?: string,
): Promise<GuardrailFindingPage> => {
  const since = new Date(Date.now() - metricWindowMilliseconds(window)).toISOString();
  const [events, metrics] = await Promise.all([
    controllerApi.listRuntimeEvents(limit, { guardrailId, since, findingsOnly: 'true', ...(cursor ? { cursor } : {}), ...(severity && severity !== 'all' ? { severity } : {}) }, signal),
    controllerApi.requestController<Metrics>(`/api/v1/runtime-metrics?${new URLSearchParams({guardrailId,window})}`, signal ? { signal } : undefined),
  ]);
  const items = events.items.flatMap(runtimeFindings).filter(f => !severity || severity === 'all' || f.severity === severity);
  if (!metrics.findings_summary) throw new Error("Runtime findings summary is unavailable. Update the Controller and retry.");
  return {
    items, count: items.length, nextCursor: events.nextCursor,
    summary: metrics.findings_summary,
    collection_status: !metrics.total_decisions ? "no_events" : metrics.data_availability?.execution_evidence === "collected" ? "collected" : "not_collected",
  };
};

function runtimeLogEntry(event: controllerApi.RuntimeEvent): RuntimeLogInteraction["entries"][number] {
  const before = runtimeLogContent(event.metadata.contentBefore);
  const after = runtimeLogContent(event.metadata.contentAfter);
  return {
    id: event.id,
    trace_id: event.requestId,
    created_at: event.occurredAt,
    phase: event.direction === "incoming" ? "input" : "output",
    outcome: normalizeOutcome(event.decision),
    action: stringValue(event.metadata.action) ?? event.decision,
    risk: runtimeFindings(event)[0]?.risk ?? arrayOfStrings(event.metadata.risks)[0] ?? null,
    latency_ms: event.durationMs,
    timed_out: isTimedOut(event),
    detail: `Runner ${event.runnerId} reported ${event.direction} decision “${event.decision}” in ${event.durationMs} ms.`,
    content_before: before,
    content_after: after,
    content_available: Boolean(event.metadata.contentAvailable) && (before !== null || after !== null),
    findings: runtimeFindings(event),
    steps: runtimeTraceSteps(event),
  };
}

function worstOutcome(values: string[]): string {
  const rank = (value: string) => ({ error: 4, block: 3, transform: 2, allow: 1 }[normalizeOutcome(value)] ?? 0);
  return [...values].sort((left, right) => rank(right) - rank(left))[0] ?? "allow";
}

export function runtimeLogInteractions(events: controllerApi.RuntimeEvent[], filters: {
  phase?: "input" | "output";
  outcome?: "allow" | "transform" | "block" | "error";
} = {}): RuntimeLogInteraction[] {
  const matching = events
    .filter((event): event is controllerApi.RuntimeEvent & { guardrailId: string } => Boolean(event.guardrailId))
    .filter((event) => event.metadata.runtimeLogCaptured === true)
    .filter((event) => !filters.phase || (event.direction === "incoming" ? "input" : "output") === filters.phase)
    .filter((event) => !filters.outcome || normalizeOutcome(event.decision) === filters.outcome);
  const grouped = new Map<string, typeof matching>();
  for (const event of matching) {
    const key = `${event.requestId}:${event.guardrailId}`;
    const group = grouped.get(key);
    if (group) group.push(event); else grouped.set(key, [event]);
  }
  return [...grouped.values()].map((events) => {
    const ordered = [...events].sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
    const first = ordered[0] as typeof events[number];
    const last = ordered.at(-1) as typeof events[number];
    return {
      id: first.requestId,
      created_at: first.occurredAt,
      completed_at: last.occurredAt,
      guardrail_id: first.guardrailId,
      guardrail_version: last.guardrailVersion,
      deployment_id: last.deploymentId,
      integration_id: last.integrationId,
      protocol: stringValue(last.metadata.protocol) ?? "unknown",
      outcome: worstOutcome(ordered.map((event) => event.decision)),
      capture_level: enumValue(last.metadata.captureLevel, ["info", "debug", "trace"]) ?? "info",
      entries: ordered.map(runtimeLogEntry),
    };
  }).sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
}

function runtimeLogContent(value: unknown): RuntimeLogInteraction["entries"][number]["content_before"] {
  if (!Array.isArray(value)) return null;
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const id = stringValue(record.id);
    const role = stringValue(record.role);
    const source = stringValue(record.source);
    const text = stringValue(record.text);
    if (!id || !role || !source || text === null) return [];
    return [{ id, role, source, text, truncated: record.truncated === true }];
  });
}

export async function getMetrics(filters: {
  guardrailId?: string; deploymentId?: string; window?: MetricWindow;
} = {}, signal?: AbortSignal): Promise<Metrics> {
  const query = new URLSearchParams({ window: filters.window ?? "24h" });
  if (filters.guardrailId) query.set("guardrailId", filters.guardrailId);
  if (filters.deploymentId) query.set("deploymentId", filters.deploymentId);
  const [metrics, status] = await Promise.all([
    controllerApi.requestController<Omit<Metrics, "system_status" | "system_reasons">>(`/api/v1/runtime-metrics?${query}`, signal ? { signal } : undefined),
    controllerApi.getControllerSystemStatus(),
  ]);
  return { ...metrics, system_status: status.status === "healthy" ? "healthy" : "degraded", system_reasons: status.reasons };
}
