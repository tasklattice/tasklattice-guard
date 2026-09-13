import * as controllerApi from "@/lib/controller-api";
import {
  arrayOfStrings,
  isTimedOut,
  metadataRecord,
  normalizeOutcome,
  runtimeFindings,
  runtimeTraceSteps,
  stringValue,
} from "@/lib/controller-api-mappers";
import type {
  Collection,
  DeleteConfirmation,
  Router,
  RouterDeletionImpact,
  RouterRuntimeTrace,
  TrafficScopeExpression,
  TrafficScopeField,
} from "@/lib/api-types";

export { listTrafficRouters as getRouters, getTrafficRouter as getRouter } from './traffic-routing-api';

export async function getRouterTraces(id: string, limit = 100, cursor?: string, signal?: AbortSignal, security?: { severity: string }): Promise<Collection<RouterRuntimeTrace>> {
  const safeLimit = Math.min(500, Math.max(1, limit));
  const events = await controllerApi.listRuntimeEvents(safeLimit, { routerId: id, ...(cursor ? { cursor } : {}), ...(security ? { findingsOnly: 'true', since: new Date(Date.now() - 86_400_000).toISOString(), ...(security.severity === 'all' ? {} : { severity: security.severity }) } : {}) }, signal);
  return { items: events.items.map(mapRouterTrace), count: events.count ?? events.items.length, nextCursor: events.nextCursor };
}
export async function getRouterTrace(id: string, signal?: AbortSignal) { return mapRouterTrace(await controllerApi.getRuntimeEvent(id, signal)); }

function mapRouterTrace(event: controllerApi.RuntimeEvent): RouterRuntimeTrace {
  const outcome = normalizeOutcome(event.decision);
  const findings = runtimeFindings(event);
  const steps = runtimeTraceSteps(event);
  const usage = metadataRecord(event.metadata.usage);
  return {
    id: event.id,
    created_at: event.occurredAt,
    router_id: event.routerId ?? "",
    guardrail_id: event.guardrailId,
    guardrail_version: event.guardrailVersion,
    endpoint_id: event.endpointId,
    protocol: stringValue(event.metadata.protocol) ?? "unknown",
    phase: event.direction === "incoming" ? "input" : "output",
    outcome,
    action: stringValue(event.metadata.action) ?? event.decision,
    risk: findings[0]?.risk ?? arrayOfStrings(event.metadata.risks)[0] ?? null,
    severity: findings[0]?.severity ?? null,
    latency_ms: event.durationMs,
    timed_out: isTimedOut(event),
    runtime_engine: stringValue(usage.runtime_engine) ?? stringValue(event.metadata.runtimeEngine) ?? "unknown",
    config_checksum: stringValue(usage.config_checksum) ?? stringValue(event.metadata.configChecksum) ?? "",
    detail: `Runner ${event.runnerId} reported ${event.direction} decision “${event.decision}” in ${event.durationMs} ms.`,
    findings,
    steps,
    evidence_status: event.metadata.captureLevel ? "collected" : "not_collected",
  };
}
