import { hasRuntimeError, runtimeOutcome, type RuntimeLogOutcome, type RuntimeOutcome } from "../../shared/runtime-outcome";
import { selectedSeverities, type EventSeverity } from "../../shared/security-severity";
import * as controllerApi from "@/lib/controller-api";
import {
  arrayOfRecords,
  arrayOfStrings,
  enumValue,
  isTimedOut,
  numberValue,
  runtimeFindings,
  runtimeTraceSteps,
  stringValue,
} from "@/lib/controller-api-mappers";
import type {
  Collection,
  GuardrailFindingPage,
  Metrics,
  MetricTrendSeries,
  MetricWindow,
  RuntimeLogInteraction,
  RuntimeHttpRequest,
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
  guardrailId: string, window: MetricWindow, limit = 100, cursor?: string, signal?: AbortSignal, severity?: string | EventSeverity[],
): Promise<GuardrailFindingPage> => {
  const since = new Date(Date.now() - metricWindowMilliseconds(window)).toISOString();
  const severities = selectedSeverities(severity);
  const [events, metrics] = await Promise.all([
    controllerApi.listRuntimeEvents(limit, { guardrailId, since, findingsOnly: 'true', ...(cursor ? { cursor } : {}), ...(severities.length ? { severity: severities.join(',') } : {}) }, signal),
    controllerApi.requestController<Metrics>(`/api/v1/telemetry/metrics?${new URLSearchParams({guardrailId,window})}`, signal ? { signal } : undefined),
  ]);
  const items = events.items.flatMap(runtimeFindings).filter(f => !severities.length || severities.includes(f.severity));
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
  const httpRequest = runtimeHttpRequest(event.metadata.httpRequest);
  return {
    id: event.id,
    trace_id: event.requestId,
    created_at: event.occurredAt,
    phase: event.direction === "completion" ? "completion" : event.direction === "incoming" ? "input" : "output",
    outcome: runtimeOutcome(event.decision),
    action: stringValue(event.metadata.action) ?? event.decision,
    risk: runtimeFindings(event)[0]?.risk ?? arrayOfStrings(event.metadata.risks)[0] ?? null,
    latency_ms: event.durationMs,
    timed_out: isTimedOut(event),
    execution_status: hasRuntimeError(event) ? "error" : event.metadata.executionStatus === "complete" ? "complete" : "unknown",
    ...(event.metadata.logKind === "call_completion" ? { call_completion: {
      inferred: event.metadata.completionInferred === true, reason: stringValue(event.metadata.failureReason),
      completed_at: stringValue(event.metadata.completedAt), decision_id: stringValue(event.metadata.decisionId),
      route_id: stringValue(event.metadata.routeId), target_id: stringValue(event.metadata.targetId), router_revision: numberValue(event.metadata.routerRevision),
    } } : {}),
    error_details: arrayOfRecords(event.metadata.trace).filter(step => hasRuntimeError({ decision: String(step.outcome ?? step.status ?? ""), metadata: { trace: [step] } })).map(step => ({
      span_id: stringValue(step.id) ?? "—", name: stringValue(step.actionName) ?? stringValue(step.name) ?? "—",
      error_type: stringValue(step.errorType), provider: stringValue(step.providerName), model: stringValue(step.modelName),
      policy: stringValue(step.policyId), timed_out: step.timedOut === true || step.status === "timeout" || step.outcome === "timeout", timeout_ms: numberValue(step.timeoutMs),
    })),
    detail: `Runner ${event.runnerId} reported ${event.direction} decision “${event.decision}” in ${event.durationMs} ms.`,
    http_request: httpRequest,
    content_before: before,
    content_after: after,
    content_available: Boolean(event.metadata.contentAvailable),
    findings: runtimeFindings(event),
    steps: runtimeTraceSteps(event),
  };
}

function worstOutcome(values: string[]): RuntimeOutcome | null {
  const outcomes = values.map(runtimeOutcome).filter((value): value is RuntimeOutcome => value !== null);
  const rank = { block: 3, transform: 2, allow: 1 };
  return outcomes.sort((left, right) => rank[right] - rank[left])[0] ?? null;
}

export function runtimeLogInteractions(events: controllerApi.RuntimeEvent[], filters: {
  includeUncaptured?: boolean;
  phase?: "input" | "output";
  outcome?: RuntimeLogOutcome;
} = {}): RuntimeLogInteraction[] {
  const matching = events
    .filter((event) => filters.includeUncaptured || event.metadata.runtimeLogCaptured === true)
    .filter((event) => !filters.phase || (event.direction === "completion" ? "completion" : event.direction === "incoming" ? "input" : "output") === filters.phase)
    .filter((event) => !filters.outcome || (filters.outcome === "error" ? hasRuntimeError(event) : runtimeOutcome(event.decision) === filters.outcome));
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
      router_id: last.routerId,
      endpoint_id: last.endpointId,
      protocol: stringValue(last.metadata.protocol) ?? "unknown",
      outcome: worstOutcome(ordered.map((event) => event.decision)),
      capture_level: enumValue(last.metadata.captureLevel, ["info", "debug", "trace"]) ?? "info",
      entries: ordered.map(runtimeLogEntry),
    };
  }).sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
}

function runtimeHttpRequest(value: unknown): RuntimeHttpRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (typeof request.method !== "string" || typeof request.target !== "string" ||
      typeof request.httpVersion !== "string" || typeof request.bodyBase64 !== "string" ||
      !Array.isArray(request.headers) || !request.headers.every(header =>
        Array.isArray(header) && header.length === 2 && header.every(part => typeof part === "string"))) return null;
  try { atob(request.bodyBase64); } catch { return null; }
  return {
    method: request.method, target: request.target, httpVersion: request.httpVersion,
    headers: request.headers as [string, string][], bodyBase64: request.bodyBase64,
    redactedHeaders: arrayOfStrings(request.redactedHeaders),
  };
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
  guardrailId?: string; routerId?: string; window?: MetricWindow;
} = {}, signal?: AbortSignal): Promise<Metrics> {
  const query = new URLSearchParams({ window: filters.window ?? "24h" });
  if (filters.guardrailId) query.set("guardrailId", filters.guardrailId);
  if (filters.routerId) query.set("routerId", filters.routerId);
  const [metrics, status] = await Promise.all([
    controllerApi.requestController<Omit<Metrics, "system_status" | "system_reasons">>(`/api/v1/telemetry/metrics?${query}`, signal ? { signal } : undefined),
    controllerApi.getControllerSystemStatus(),
  ]);
  // A successful HTTP response can still be a collection or an incomplete
  // snapshot. Reject it before rendering; missing telemetry is not zero traffic.
  if (!metrics || ![
    metrics.total_decisions, metrics.allowed, metrics.blocked, metrics.intervened,
    metrics.errors, metrics.intervention_rate, metrics.error_rate, metrics.timeout_count,
    metrics.runtime_p95_ms, metrics.fail_closed_count, metrics.degraded_endpoints,
    metrics.total_guardrails, metrics.guardrails_needing_test, metrics.total_routers,
  ].every(Number.isFinite)
    || !metrics.comparison || ![
      metrics.comparison.request_delta_pct, metrics.comparison.intervention_rate_delta_pp,
      metrics.comparison.runtime_p95_delta_ms, metrics.comparison.error_rate_delta_pp,
    ].every(value => value === null || Number.isFinite(value))
    || !["healthy", "breached"].includes(metrics.latency_slo?.p95_status)
    || !["1h", "24h", "7d", "15d", "30d"].includes(metrics.window)
    || !["1m", "15m", "1h", "6h", "1d"].includes(metrics.interval)
    || !validMetricSeries(metrics.trend_series?.none)) {
    throw new Error("Runtime metrics are unavailable or incomplete. Check the Controller response and retry.");
  }
  return { ...metrics, system_status: status.status === "healthy" ? "healthy" : "degraded", system_reasons: status.reasons };
}

function validMetricSeries(series: MetricTrendSeries[] | undefined): boolean {
  return Array.isArray(series) && series.every(item => item && typeof item.name === "string"
    && Array.isArray(item.points) && item.points.every(point => point
      && typeof point.timestamp === "string" && Number.isFinite(Date.parse(point.timestamp))
      && [point.total, point.allowed, point.blocked, point.transformed, point.errored,
        point.timed_out, point.p50_latency_ms, point.p95_latency_ms, point.p99_latency_ms].every(Number.isFinite)));
}
