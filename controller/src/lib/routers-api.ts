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

const DEFAULT_ROUTER_ID = "router-default";
const emptyCollection = <T>(): Collection<T> => ({ items: [], count: 0 });

function normalizeTrafficScope(value: Record<string, unknown>): TrafficScopeExpression {
  if ((value.combinator === "and" || value.combinator === "or") && Array.isArray(value.conditions)) {
    return value as TrafficScopeExpression;
  }
  if (Object.keys(value).length === 0) return { combinator: "and", conditions: [] };
  throw new Error("Controller 返回了旧 UI 无法表达的 Traffic Scope。");
}

function mapRouters(
  values: controllerApi.Router[],
  guardrails: controllerApi.Guardrail[],
): Router[] {
  const guardrailById = new Map(guardrails.map((item) => [item.id, item]));
  return values.map((item) => {
    const isDefault = item.id === DEFAULT_ROUTER_ID;
    return {
      id: item.id,
      name: item.name,
      guardrail_id: item.guardrailId,
      guardrail_version: item.guardrailVersion ?? guardrailById.get(item.guardrailId)?.activeVersion ?? "",
      endpoint_id: item.endpointId,
      route_order: item.routeOrder,
      traffic_scope: normalizeTrafficScope(item.trafficScope),
      enabled: item.enabled,
      is_default: isDefault,
      system_managed: isDefault,
      updated_at: item.updatedAt,
    };
  });
}

export async function getRouters(): Promise<Collection<Router>> {
  const [routers, guardrails] = await Promise.all([
    controllerApi.listControllerRouters(),
    controllerApi.listControllerGuardrails(),
  ]);
  const items = mapRouters(routers.items, guardrails.items);
  return { items, count: items.length };
}

export async function getRouter(id: string): Promise<Router> {
  const routers = await getRouters();
  const found = routers.items.find((item) => item.id === id);
  if (!found) throw new Error(`Router ${id} was not found.`);
  return found;
}

export async function getRouterDeletionImpact(id: string): Promise<RouterDeletionImpact> {
  const [impact, router] = await Promise.all([
    controllerApi.getControllerRouterDeletionImpact(id),
    getRouter(id),
  ]);
  if (
    impact.resourceId !== id
    || typeof impact.windowMinutes !== "number"
    || typeof impact.incomingRequestCount !== "number"
    || typeof impact.activeRouterCount !== "number"
    || typeof impact.telemetryFresh !== "boolean"
    || typeof impact.requiresSecondConfirmation !== "boolean"
  ) {
    throw new Error("Router deletion impact is unavailable. Ensure the Controller API is updated, then retry.");
  }
  return {
    router_id: impact.resourceId,
    router_name: router.name,
    window_minutes: impact.windowMinutes,
    incoming_request_count: impact.incomingRequestCount,
    last_request_at: impact.lastRequestAt,
    active_router_count: impact.activeRouterCount,
    telemetry_fresh: impact.telemetryFresh,
    telemetry_watermark: impact.telemetryWatermark,
    requires_second_confirmation: impact.requiresSecondConfirmation,
    requires_confirmation: impact.requiresSecondConfirmation,
  };
}

export const deleteRouter = (id: string, confirmation: DeleteConfirmation) => controllerApi.deleteControllerRouter(id, {
  reason: confirmation.reason,
  confirmRecentTraffic: confirmation.confirm_recent_traffic,
  ...(confirmation.confirmation_name ? { confirmationName: confirmation.confirmation_name } : {}),
});

export async function createRouter(input: {
  name: string;
  guardrail_id: string;
  endpoint_id?: string | null;
  traffic_scope: TrafficScopeExpression;
  enabled: boolean;
}): Promise<Router> {
  if (!input.endpoint_id) throw new Error("Controller 部署必须选择 Endpoint。");
  const created = await controllerApi.createControllerRouter({
    name: input.name,
    guardrailId: input.guardrail_id,
    endpointId: input.endpoint_id,
    poolId: "default",
    trafficScope: input.traffic_scope,
    enabled: input.enabled,
  });
  const guardrail = await controllerApi.getControllerGuardrail(created.guardrailId);
  return mapRouters([created], [guardrail])[0] as Router;
}

export async function createRouterBindings(input: {
  name: string;
  guardrail_id: string;
  endpoint_ids: string[];
  traffic_scope: TrafficScopeExpression;
  enabled: boolean;
}): Promise<Collection<Router>> {
  if (!input.endpoint_ids.length) return emptyCollection();
  const response = await controllerApi.requestController<{ items: controllerApi.Router[]; count: number }>("/api/v1/router-bindings", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      guardrailId: input.guardrail_id,
      endpointIds: input.endpoint_ids,
      poolId: "default",
      trafficScope: input.traffic_scope,
      enabled: input.enabled,
    }),
  });
  const guardrail = await controllerApi.getControllerGuardrail(input.guardrail_id);
  return { items: mapRouters(response.items, [guardrail]), count: response.count };
}

export async function reorderRouterRoutes(endpointId: string, routerIds: string[]): Promise<Collection<Router>> {
  const response = await controllerApi.reorderControllerRouters(endpointId, routerIds);
  const guardrails = await controllerApi.listControllerGuardrails();
  const items = mapRouters(response.items, guardrails.items);
  return { items, count: items.length };
}
export async function setRouterEnabled(id: string, enabled: boolean): Promise<Router> {
  const item = await controllerApi.setControllerRouterEnabled(id, enabled);
  const guardrail = await controllerApi.getControllerGuardrail(item.guardrailId);
  return mapRouters([item], [guardrail])[0]!;
}
export async function updateRouterTrafficScope(id: string, trafficScope: TrafficScopeExpression): Promise<Router> {
  const item = await controllerApi.updateControllerRouterTrafficScope(id, trafficScope);
  const guardrail = await controllerApi.getControllerGuardrail(item.guardrailId);
  return mapRouters([item], [guardrail])[0]!;
}
export const getTrafficScopeFields = (): Promise<Collection<TrafficScopeField>> => controllerApi.requestController<Collection<TrafficScopeField>>("/api/v1/traffic-scope-fields");

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
