import * as controllerApi from "@/lib/controller-api";
import {
  arrayOfRecords,
  arrayOfStrings,
  enumValue,
  isTimedOut,
  metadataRecord,
  normalizeOutcome,
  numberValue,
  runtimeFindings,
  runtimeTraceSteps,
  stringValue,
} from "@/lib/controller-api-mappers";
import type {
  Collection,
  EvidenceRecord,
  GuardrailFindingPage,
  Metrics,
  MetricTrendPoint,
  MetricWindow,
  RuntimeLogInteraction,
  RuntimeLogPage,
} from "@/lib/api-types";

function windowMilliseconds(window: MetricWindow): number {
  return {
    "1h": 60 * 60 * 1_000,
    "24h": 24 * 60 * 60 * 1_000,
    "7d": 7 * 24 * 60 * 60 * 1_000,
    "15d": 15 * 24 * 60 * 60 * 1_000,
    "30d": 30 * 24 * 60 * 60 * 1_000,
  }[window];
}

function inWindow(timestamp: string, window: MetricWindow, now = Date.now()): boolean {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) && value >= now - windowMilliseconds(window) && value <= now;
}

function metadataStrings(metadata: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [
    key,
    typeof value === "string" ? value : JSON.stringify(value) ?? String(value),
  ]));
}

function runtimeEvidence(event: controllerApi.RuntimeEvent): EvidenceRecord {
  return {
    id: event.id,
    created_at: event.occurredAt,
    kind: "interaction.decision",
    outcome: normalizeOutcome(event.decision),
    guardrail_id: event.guardrailId,
    deployment_id: event.deploymentId,
    integration_id: event.integrationId,
    risk: stringValue(event.metadata.risk),
    detail: `Runner ${event.runnerId} reported ${event.direction} decision “${event.decision}” in ${event.durationMs} ms.`,
    actor_id: null,
    metadata: {
      ...metadataStrings(event.metadata),
      request_id: event.requestId,
      runner_id: event.runnerId,
      direction: event.direction,
      duration_ms: String(event.durationMs),
    },
  };
}

function auditEvidence(event: controllerApi.AuditEvent): EvidenceRecord {
  return {
    id: event.id,
    created_at: event.occurredAt,
    kind: event.kind,
    outcome: "recorded",
    guardrail_id: event.resourceType === "guardrail" ? event.resourceId : stringValue(event.detail.guardrailId),
    deployment_id: event.resourceType === "deployment" ? event.resourceId : stringValue(event.detail.deploymentId),
    integration_id: event.resourceType === "integration" ? event.resourceId : stringValue(event.detail.integrationId),
    risk: stringValue(event.detail.risk),
    detail: JSON.stringify(event.detail),
    actor_id: event.actorId,
    metadata: metadataStrings(event.detail),
  };
}

export async function getEvidence(filters: {
  limit?: number;
  guardrailId?: string;
  deploymentId?: string;
  kind?: string;
  outcome?: string;
  risk?: string;
  window?: MetricWindow;
} = {}): Promise<Collection<EvidenceRecord>> {
  const window = filters.window ?? "24h";
  const now = Date.now();
  const since = new Date(now - windowMilliseconds(window)).toISOString();
  const [runtime, audit] = await Promise.all([
    controllerApi.listRuntimeEvents(10_000, {
      guardrailId: filters.guardrailId,
      deploymentId: filters.deploymentId,
      since,
    }),
    controllerApi.listAuditEvents(500),
  ]);
  const matching = [...runtime.items.map(runtimeEvidence), ...audit.items.map(auditEvidence)]
    .filter((item) => inWindow(item.created_at, window, now))
    .filter((item) => !filters.guardrailId || item.guardrail_id === filters.guardrailId)
    .filter((item) => !filters.deploymentId || item.deployment_id === filters.deploymentId)
    .filter((item) => !filters.kind || item.kind === filters.kind)
    .filter((item) => !filters.outcome || item.outcome === filters.outcome)
    .filter((item) => !filters.risk || item.risk === filters.risk)
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  return {
    items: matching.slice(0, Math.min(500, Math.max(1, filters.limit ?? 100))),
    count: matching.length,
  };
}

export const getGuardrailFindings = async (
  guardrailId: string,
  window: MetricWindow,
  limit = 200,
): Promise<GuardrailFindingPage> => {
  const since = new Date(Date.now() - windowMilliseconds(window)).toISOString();
  const events = await controllerApi.listRuntimeEvents(10_000, { guardrailId, since });
  const all = events.items.flatMap(runtimeFindings).sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  const items = all.slice(0, Math.min(1_000, Math.max(1, limit)));
  return {
    items,
    count: items.length,
    summary: {
      total: all.length,
      critical: all.filter((item) => item.severity === "critical").length,
      high: all.filter((item) => item.severity === "high").length,
      medium: all.filter((item) => item.severity === "medium").length,
      low: all.filter((item) => item.severity === "low").length,
      affected_traces: new Set(all.map((item) => item.trace_id)).size,
      latest_at: all[0]?.created_at ?? null,
    },
    collection_status: !events.items.length ? "no_events" : events.items.every((event) => Boolean(event.metadata.captureLevel)) ? "collected" : "not_collected",
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

export async function getRuntimeLogs(filters: {
  limit?: number;
  guardrailId?: string;
  phase?: "input" | "output";
  outcome?: "allow" | "transform" | "block" | "error";
  window?: MetricWindow;
  cursor?: string;
} = {}): Promise<RuntimeLogPage> {
  const runtime = await controllerApi.listRuntimeEvents(10_000, {
    ...(filters.guardrailId ? { guardrailId: filters.guardrailId } : {}),
    since: new Date(Date.now() - windowMilliseconds(filters.window ?? "24h")).toISOString(),
  });
  const window = filters.window ?? "24h";
  const matching = runtime.items
    .filter((event): event is controllerApi.RuntimeEvent & { guardrailId: string } => Boolean(event.guardrailId))
    .filter((event) => event.metadata.runtimeLogCaptured === true)
    .filter((event) => inWindow(event.occurredAt, window))
    .filter((event) => !filters.guardrailId || event.guardrailId === filters.guardrailId)
    .filter((event) => !filters.phase || (event.direction === "incoming" ? "input" : "output") === filters.phase)
    .filter((event) => !filters.outcome || normalizeOutcome(event.decision) === filters.outcome);
  const grouped = new Map<string, typeof matching>();
  for (const event of matching) {
    const key = `${event.requestId}:${event.guardrailId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }
  const allItems: RuntimeLogInteraction[] = [...grouped.values()].map((events) => {
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
  const offset = parseCursor(filters.cursor);
  const limit = Math.min(500, Math.max(1, filters.limit ?? 100));
  const items = allItems.slice(offset, offset + limit);
  return {
    items,
    count: allItems.length,
    next_cursor: offset + limit < allItems.length ? `offset:${offset + limit}` : null,
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

function parseCursor(cursor: string | undefined): number {
  if (!cursor?.startsWith("offset:")) return 0;
  const value = Number.parseInt(cursor.slice("offset:".length), 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

type EventSummary = {
  total: number;
  allowed: number;
  blocked: number;
  transformed: number;
  errors: number;
  timeouts: number;
  p50: number;
  p95: number;
  p99: number;
};

function summarizeEvents(events: controllerApi.RuntimeEvent[]): EventSummary {
  const outcomes = events.map((event) => normalizeOutcome(event.decision));
  const latencies = events.map((event) => event.durationMs);
  return {
    total: events.length,
    allowed: outcomes.filter((value) => value === "allow").length,
    blocked: outcomes.filter((value) => value === "block").length,
    transformed: outcomes.filter((value) => value === "transform").length,
    errors: outcomes.filter((value) => value === "error").length,
    timeouts: events.filter(isTimedOut).length,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
  };
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return Math.round(sorted[index] ?? 0);
}

function percentage(numerator: number, denominator: number): number {
  return denominator ? Math.round(numerator / denominator * 10_000) / 100 : 0;
}

function percentageDelta(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round((current - previous) / previous * 10_000) / 100;
}

function metricInterval(window: MetricWindow): Metrics["interval"] {
  return { "1h": "1m", "24h": "15m", "7d": "1h", "15d": "6h", "30d": "1d" }[window] as Metrics["interval"];
}

function intervalMilliseconds(interval: Metrics["interval"]): number {
  return { "1m": 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000, "6h": 6 * 60 * 60_000, "1d": 24 * 60 * 60_000 }[interval];
}

function buildTrend(events: controllerApi.RuntimeEvent[], window: MetricWindow, now: number): MetricTrendPoint[] {
  const interval = metricInterval(window);
  const step = intervalMilliseconds(interval);
  const first = Math.floor((now - windowMilliseconds(window)) / step) * step;
  const buckets = new Map<number, controllerApi.RuntimeEvent[]>();
  for (const event of events) {
    const timestamp = Date.parse(event.occurredAt);
    const bucket = Math.floor(timestamp / step) * step;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), event]);
  }
  const points: MetricTrendPoint[] = [];
  for (let timestamp = first; timestamp <= now; timestamp += step) {
    const summary = summarizeEvents(buckets.get(timestamp) ?? []);
    points.push({
      timestamp: new Date(timestamp).toISOString(),
      total: summary.total,
      allowed: summary.allowed,
      blocked: summary.blocked,
      transformed: summary.transformed,
      errored: summary.errors,
      timed_out: summary.timeouts,
      p50_latency_ms: summary.p50,
      p95_latency_ms: summary.p95,
      p99_latency_ms: summary.p99,
    });
  }
  return points;
}

function scopedEvents(
  values: controllerApi.RuntimeEvent[],
  filters: { guardrailId?: string; deploymentId?: string },
): controllerApi.RuntimeEvent[] {
  return values
    .filter((event) => !filters.guardrailId || event.guardrailId === filters.guardrailId)
    .filter((event) => !filters.deploymentId || event.deploymentId === filters.deploymentId);
}

function eventUsage(event: controllerApi.RuntimeEvent): Record<string, unknown> {
  return metadataRecord(event.metadata.usage);
}

function usageValues(events: controllerApi.RuntimeEvent[], key: string): number[] {
  return events.map((event) => numberValue(eventUsage(event)[key])).filter((value): value is number => value !== null);
}

function usageTotal(events: controllerApi.RuntimeEvent[], key: string): number {
  return usageValues(events, key).reduce((total, value) => total + value, 0);
}

function componentMetrics(events: controllerApi.RuntimeEvent[], kind: "rail" | "action"): Metrics["rail_metrics"] {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const event of events) {
    for (const step of arrayOfRecords(event.metadata.trace)) {
      const stepKind = stringValue(step.kind) ?? "";
      if (kind === "rail" ? stepKind !== "rail" : stepKind !== "action") continue;
      const name = stringValue(step.name) ?? stringValue(step.actionName) ?? stringValue(step.flowName) ?? "runtime-step";
      groups.set(name, [...(groups.get(name) ?? []), step]);
    }
  }
  return [...groups.entries()].map(([name, steps]) => {
    const durations = steps.map((step) => numberValue(step.durationMs) ?? 0);
    const providers = steps.map((step) => numberValue(step.providerLatencyMs) ?? 0);
    const outcomes = steps.map((step) => stringValue(step.outcome) ?? stringValue(step.status) ?? "unknown");
    const first = steps[0] ?? {};
    const timeouts = steps.filter((step) => step.timedOut === true).length;
    return {
      name,
      risk: stringValue(first.risk),
      policy_id: stringValue(first.policyId),
      policy_version: numberValue(first.policyVersion),
      rail_type: stringValue(first.railType),
      flow_name: stringValue(first.flowName),
      action_name: stringValue(first.actionName),
      action_version: stringValue(first.actionVersion),
      parallel_group: stringValue(first.parallelGroup),
      invocations: steps.length,
      passed: outcomes.filter((value) => ["passed", "safe", "allow", "complete"].includes(value)).length,
      intervened: outcomes.filter((value) => ["unsafe", "block", "transform", "intervene", "enforce"].includes(value)).length,
      uncertain: outcomes.filter((value) => value === "uncertain").length,
      errors: outcomes.filter((value) => value === "error").length,
      timeouts,
      p50_latency_ms: percentile(durations, 0.5),
      p95_latency_ms: percentile(durations, 0.95),
      p99_latency_ms: percentile(durations, 0.99),
      provider_p50_ms: percentile(providers, 0.5),
      provider_p95_ms: percentile(providers, 0.95),
      provider_p99_ms: percentile(providers, 0.99),
    };
  });
}

function policyMetrics(events: controllerApi.RuntimeEvent[], requestCount: number): Metrics["policy_distribution"] {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const event of events) {
    for (const step of arrayOfRecords(event.metadata.trace)) {
      const policyId = stringValue(step.policyId);
      if (!policyId) continue;
      groups.set(policyId, [...(groups.get(policyId) ?? []), step]);
    }
  }
  const totalInvocations = [...groups.values()].reduce((total, steps) => total + steps.length, 0);
  return [...groups.entries()].map(([policyId, steps]) => {
    const durations = steps.map((step) => numberValue(step.durationMs) ?? 0);
    const providerDurations = steps.map((step) => numberValue(step.providerLatencyMs) ?? 0);
    const outcomes = steps.map((step) => stringValue(step.outcome) ?? stringValue(step.verdict) ?? stringValue(step.status) ?? "unknown");
    const versionText = stringValue(steps[0]?.policyVersion);
    const parsedVersion = versionText ? Number.parseInt(versionText, 10) : Number.NaN;
    return {
      policy_id: policyId,
      policy_version: Number.isFinite(parsedVersion) ? parsedVersion : null,
      invocations: steps.length,
      hit_share: percentage(steps.length, totalInvocations),
      hits_per_request: requestCount ? Math.round(steps.length / requestCount * 100) / 100 : 0,
      passed: outcomes.filter((value) => ["passed", "safe", "allow", "complete"].includes(value)).length,
      intervened: outcomes.filter((value) => ["unsafe", "block", "transform", "intervene", "enforce"].includes(value)).length,
      errors: outcomes.filter((value) => value === "error").length,
      timeouts: steps.filter((step) => step.timedOut === true).length,
      p50_latency_ms: percentile(durations, 0.5),
      p95_latency_ms: percentile(durations, 0.95),
      p99_latency_ms: percentile(durations, 0.99),
      provider_p95_ms: percentile(providerDurations, 0.95),
      rail_types: unique(steps.map((step) => stringValue(step.railType)).filter((item): item is string => Boolean(item))),
      parallel_groups: unique(steps.map((step) => stringValue(step.parallelGroup)).filter((item): item is string => Boolean(item))),
    };
  });
}

export async function getMetrics(filters: {
  guardrailId?: string;
  deploymentId?: string;
  window?: MetricWindow;
} = {}): Promise<Metrics> {
  const window = filters.window ?? "24h";
  const duration = windowMilliseconds(window);
  const now = Date.now();
  const windowStart = now - duration;
  const [runtime, guardrails, deployments, integrations, status] = await Promise.all([
    controllerApi.listRuntimeEvents(10_000, {
      ...(filters.guardrailId ? { guardrailId: filters.guardrailId } : {}),
      ...(filters.deploymentId ? { deploymentId: filters.deploymentId } : {}),
      since: new Date(windowStart - duration).toISOString(),
      before: new Date(now).toISOString(),
    }),
    controllerApi.listControllerGuardrails(),
    controllerApi.listControllerDeployments(),
    controllerApi.listControllerIntegrations(),
    controllerApi.getControllerSystemStatus(),
  ]);
  const allScoped = scopedEvents(runtime.items, filters);
  const currentEvents = allScoped.filter((event) => {
    const timestamp = Date.parse(event.occurredAt);
    return timestamp >= windowStart && timestamp <= now;
  });
  const previousEvents = allScoped.filter((event) => {
    const timestamp = Date.parse(event.occurredAt);
    return timestamp >= windowStart - duration && timestamp < windowStart;
  });
  const current = summarizeEvents(currentEvents);
  const previous = summarizeEvents(previousEvents);
  const currentInterventionRate = percentage(current.blocked + current.transformed, current.total);
  const previousInterventionRate = percentage(previous.blocked + previous.transformed, previous.total);
  const currentErrorRate = percentage(current.errors, current.total);
  const previousErrorRate = percentage(previous.errors, previous.total);
  const guardrailById = new Map(guardrails.items.map((item) => [item.id, item]));
  const deploymentById = new Map(deployments.items.map((item) => [item.id, item]));
  const integrationById = new Map(integrations.items.map((item) => [item.id, item]));
  const scopedDeployments = deployments.items.filter((item) =>
    (!filters.guardrailId || item.guardrailId === filters.guardrailId)
    && (!filters.deploymentId || item.id === filters.deploymentId));
  const sloP95 = 2_500;
  const sloP99 = 5_000;
  const trend = buildTrend(currentEvents, window, now);
  const guardrailGroups = groupEvents(currentEvents, (event) => event.guardrailId);
  const callerGroups = groupEvents(currentEvents, (event) => `${event.integrationId ?? ""}\u0000${event.deploymentId ?? ""}`);
  const versionGroups = groupEvents(currentEvents, (event) => `${event.guardrailId ?? ""}\u0000${event.guardrailVersion ?? 0}`);
  const riskCounts = new Map<string, number>();
  for (const finding of currentEvents.flatMap(runtimeFindings)) riskCounts.set(finding.risk, (riskCounts.get(finding.risk) ?? 0) + 1);
  const engineGroups = groupEvents(currentEvents, (event) => stringValue(eventUsage(event).runtime_engine) ?? stringValue(event.metadata.runtimeEngine) ?? "unknown");
  const queueLatencies = usageValues(currentEvents, "queue_latency_ms");
  const providerLatencies = usageValues(currentEvents, "provider_latency_ms");
  const evidenceCount = currentEvents.filter((event) => Boolean(event.metadata.captureLevel)).length;
  const railMetrics = componentMetrics(currentEvents, "rail");
  const actionMetrics = componentMetrics(currentEvents, "action");
  const degradedIntegrationIds = new Set(currentEvents
    .filter((event) => normalizeOutcome(event.decision) === "error" && event.integrationId)
    .map((event) => event.integrationId as string));
  return {
    data_availability: {
      runtime_events: (runtime.count ?? runtime.items.length) > runtime.items.length ? "truncated" : "complete",
      execution_evidence: !currentEvents.length || evidenceCount === currentEvents.length ? "collected" : evidenceCount ? "partial" : "not_collected",
      returned_events: runtime.items.length,
      matching_events: runtime.count ?? runtime.items.length,
    },
    window,
    window_start: new Date(windowStart).toISOString(),
    scope: {
      guardrail_id: filters.guardrailId ?? null,
      guardrail_name: filters.guardrailId ? guardrailById.get(filters.guardrailId)?.name ?? null : null,
    },
    comparison: {
      previous_total_decisions: previous.total,
      request_delta_pct: percentageDelta(current.total, previous.total),
      previous_intervention_rate: previous.total ? previousInterventionRate : null,
      intervention_rate_delta_pp: previous.total ? Math.round((currentInterventionRate - previousInterventionRate) * 100) / 100 : null,
      previous_runtime_p95_ms: previous.total ? previous.p95 : null,
      runtime_p95_delta_ms: previous.total ? current.p95 - previous.p95 : null,
      previous_error_rate: previous.total ? previousErrorRate : null,
      error_rate_delta_pp: previous.total ? Math.round((currentErrorRate - previousErrorRate) * 100) / 100 : null,
    },
    total_decisions: current.total,
    allowed: current.allowed,
    blocked: current.blocked,
    intervened: current.transformed,
    errors: current.errors,
    block_rate: percentage(current.blocked, current.total),
    intervention_rate: currentInterventionRate,
    error_rate: currentErrorRate,
    timeout_count: current.timeouts,
    rail_invocations: usageTotal(currentEvents, "rail_invocations"),
    action_invocations: usageTotal(currentEvents, "action_invocations"),
    model_invocations: usageTotal(currentEvents, "model_invocations"),
    cache_hits: usageTotal(currentEvents, "cache_hits"),
    cache_misses: usageTotal(currentEvents, "cache_misses"),
    cache_hit_rate: percentage(usageTotal(currentEvents, "cache_hits"), usageTotal(currentEvents, "cache_hits") + usageTotal(currentEvents, "cache_misses")),
    queue_p50_ms: percentile(queueLatencies, 0.5),
    queue_p95_ms: percentile(queueLatencies, 0.95),
    queue_p99_ms: percentile(queueLatencies, 0.99),
    provider_p50_ms: percentile(providerLatencies, 0.5),
    provider_p95_ms: percentile(providerLatencies, 0.95),
    provider_p99_ms: percentile(providerLatencies, 0.99),
    fail_closed_count: currentEvents.filter((event) => eventUsage(event).fail_closed === true).length,
    peak_active_concurrency: Math.max(0, ...usageValues(currentEvents, "active_concurrency")),
    slo_breach_count: currentEvents.filter((event) => event.durationMs > sloP95).length,
    runtime_engine_counts: [...engineGroups.entries()].map(([runtime_engine, values]) => ({ runtime_engine, count: values.length })),
    rail_metrics: railMetrics,
    action_metrics: actionMetrics,
    runtime_p50_ms: current.p50,
    runtime_p95_ms: current.p95,
    runtime_p99_ms: current.p99,
    latency_slo: {
      p95_budget_ms: sloP95,
      p99_budget_ms: sloP99,
      p95_status: current.p95 <= sloP95 ? "healthy" : "breached",
      p99_status: current.p99 <= sloP99 ? "healthy" : "breached",
    },
    latest_validation_p95_ms: Math.max(0, ...guardrails.items.map((item) => item.latestValidationRun?.metrics.p95LatencyMs ?? 0)),
    active_deployments: scopedDeployments.filter((item) => item.enabled).length,
    total_deployments: scopedDeployments.length,
    guardrails_needing_test: guardrails.items.filter((item) => !item.latestValidationRun || item.latestValidationRun.sourceDraftRevision !== item.draftRevision || item.latestValidationRun.status !== "passed").length,
    total_guardrails: guardrails.items.length,
    degraded_integrations: degradedIntegrationIds.size,
    total_integrations: integrations.items.length,
    risk_counts: [...riskCounts.entries()].map(([risk, count]) => ({ risk, count })),
    guardrail_distribution: [...guardrailGroups.entries()].filter(([id]) => Boolean(id)).map(([id, values]) => {
      const summary = summarizeEvents(values);
      return {
        guardrail_id: id,
        name: guardrailById.get(id)?.name ?? id,
        total: summary.total,
        share: percentage(summary.total, current.total),
        allowed: summary.allowed,
        blocked: summary.blocked,
        intervened: summary.transformed,
        errors: summary.errors,
        block_rate: percentage(summary.blocked, summary.total),
        intervention_rate: percentage(summary.blocked + summary.transformed, summary.total),
        error_rate: percentage(summary.errors, summary.total),
        p50_latency_ms: summary.p50,
        p95_latency_ms: summary.p95,
        p99_latency_ms: summary.p99,
        timeout_count: summary.timeouts,
        rail_invocations: usageTotal(values, "rail_invocations"),
        action_invocations: usageTotal(values, "action_invocations"),
        model_invocations: usageTotal(values, "model_invocations"),
        cache_hits: usageTotal(values, "cache_hits"),
        cache_misses: usageTotal(values, "cache_misses"),
        queue_p95_ms: percentile(usageValues(values, "queue_latency_ms"), 0.95),
        rail_p95_ms: percentile(componentMetrics(values, "rail").map((item) => item.p95_latency_ms), 0.95),
        action_p95_ms: percentile(componentMetrics(values, "action").map((item) => item.p95_latency_ms), 0.95),
        provider_p95_ms: percentile(usageValues(values, "provider_latency_ms"), 0.95),
        fail_closed_count: values.filter((event) => eventUsage(event).fail_closed === true).length,
        peak_active_concurrency: Math.max(0, ...usageValues(values, "active_concurrency")),
        slo_breach_count: values.filter((event) => event.durationMs > sloP95).length,
        runtime_engines: unique(values.map((event) => stringValue(eventUsage(event).runtime_engine) ?? stringValue(event.metadata.runtimeEngine) ?? "unknown")),
        config_checksums: unique(values.map((event) => stringValue(eventUsage(event).config_checksum) ?? stringValue(event.metadata.configChecksum)).filter((item): item is string => Boolean(item))),
        versions: unique(values.map((event) => event.guardrailVersion).filter((item): item is number => item !== null)),
      };
    }),
    caller_distribution: [...callerGroups.entries()].map(([key, values]) => {
      const [integrationId = "", deploymentId = ""] = key.split("\u0000");
      const summary = summarizeEvents(values);
      return {
        integration_id: integrationId || null,
        integration_name: integrationId ? integrationById.get(integrationId)?.name ?? integrationId : "Unassigned",
        deployment_id: deploymentId || null,
        deployment_name: deploymentId ? deploymentById.get(deploymentId)?.name ?? deploymentId : "Unassigned",
        protocol: stringValue(values[0]?.metadata.protocol) ?? "unknown",
        requests: summary.total,
        share: percentage(summary.total, current.total),
        allowed: summary.allowed,
        blocked: summary.blocked,
        intervened: summary.transformed,
        errors: summary.errors,
        intervention_rate: percentage(summary.blocked + summary.transformed, summary.total),
        error_rate: percentage(summary.errors, summary.total),
        p95_latency_ms: summary.p95,
        guardrail_versions: unique(values.map((event) => event.guardrailVersion).filter((item): item is number => item !== null)),
      };
    }),
    version_distribution: [...versionGroups.entries()].filter(([key]) => !key.startsWith("\u0000")).map(([key, values]) => {
      const [guardrailId = "", version = "0"] = key.split("\u0000");
      const summary = summarizeEvents(values);
      return {
        guardrail_id: guardrailId,
        guardrail_name: guardrailById.get(guardrailId)?.name ?? guardrailId,
        guardrail_version: Number(version),
        requests: summary.total,
        share: percentage(summary.total, current.total),
        p95_latency_ms: summary.p95,
        errors: summary.errors,
        slo_breaches: values.filter((event) => event.durationMs > sloP95).length,
      };
    }),
    policy_distribution: policyMetrics(currentEvents, current.total),
    unassigned_requests: currentEvents.filter((event) => !event.deploymentId).length,
    interval: metricInterval(window),
    trend,
    trend_series: {
      none: [{ name: "All traffic", points: trend }],
      guardrail: [...guardrailGroups.entries()].filter(([id]) => Boolean(id)).map(([id, values]) => ({
        name: guardrailById.get(id)?.name ?? id,
        points: buildTrend(values, window, now),
      })),
    },
    system_status: status.status === "ready" ? "healthy" : "degraded",
  };
}

function groupEvents(
  events: controllerApi.RuntimeEvent[],
  key: (event: controllerApi.RuntimeEvent) => string | null,
): Map<string, controllerApi.RuntimeEvent[]> {
  const result = new Map<string, controllerApi.RuntimeEvent[]>();
  for (const event of events) {
    const value = key(event);
    if (value === null) continue;
    result.set(value, [...(result.get(value) ?? []), event]);
  }
  return result;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
