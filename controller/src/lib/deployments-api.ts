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
  Deployment,
  DeploymentDeletionImpact,
  DeploymentRuntimeTrace,
  TrafficScopeExpression,
  TrafficScopeField,
} from "@/lib/api-types";

const DEFAULT_DEPLOYMENT_ID = "deployment-default";
const emptyCollection = <T>(): Collection<T> => ({ items: [], count: 0 });

function normalizeTrafficScope(value: Record<string, unknown>): TrafficScopeExpression {
  if ((value.combinator === "and" || value.combinator === "or") && Array.isArray(value.conditions)) {
    return value as TrafficScopeExpression;
  }
  if (Object.keys(value).length === 0) return { combinator: "and", conditions: [] };
  throw new Error("Controller 返回了旧 UI 无法表达的 Traffic Scope。");
}

function mapDeployments(
  values: controllerApi.Deployment[],
  guardrails: controllerApi.Guardrail[],
): Deployment[] {
  const guardrailById = new Map(guardrails.map((item) => [item.id, item]));
  return values.map((item) => {
    const isDefault = item.id === DEFAULT_DEPLOYMENT_ID;
    return {
      id: item.id,
      name: item.name,
      guardrail_id: item.guardrailId,
      guardrail_version: item.guardrailVersion ?? guardrailById.get(item.guardrailId)?.activeVersion ?? 0,
      integration_id: item.integrationId,
      route_order: item.routeOrder,
      traffic_scope: normalizeTrafficScope(item.trafficScope),
      enabled: item.enabled,
      is_default: isDefault,
      system_managed: isDefault,
      updated_at: item.updatedAt,
    };
  });
}

export async function getDeployments(): Promise<Collection<Deployment>> {
  const [deployments, guardrails] = await Promise.all([
    controllerApi.listControllerDeployments(),
    controllerApi.listControllerGuardrails(),
  ]);
  const items = mapDeployments(deployments.items, guardrails.items);
  return { items, count: items.length };
}

export async function getDeployment(id: string): Promise<Deployment> {
  const deployments = await getDeployments();
  const found = deployments.items.find((item) => item.id === id);
  if (!found) throw new Error(`Deployment ${id} was not found.`);
  return found;
}

export async function getDeploymentDeletionImpact(id: string): Promise<DeploymentDeletionImpact> {
  const [impact, deployment] = await Promise.all([
    controllerApi.getControllerDeploymentDeletionImpact(id),
    getDeployment(id),
  ]);
  if (
    impact.resourceId !== id
    || typeof impact.windowMinutes !== "number"
    || typeof impact.incomingRequestCount !== "number"
    || typeof impact.activeDeploymentCount !== "number"
    || typeof impact.telemetryFresh !== "boolean"
    || typeof impact.requiresSecondConfirmation !== "boolean"
  ) {
    throw new Error("Deployment deletion impact is unavailable. Ensure the Controller API is updated, then retry.");
  }
  return {
    deployment_id: impact.resourceId,
    deployment_name: deployment.name,
    window_minutes: impact.windowMinutes,
    incoming_request_count: impact.incomingRequestCount,
    last_request_at: impact.lastRequestAt,
    active_deployment_count: impact.activeDeploymentCount,
    telemetry_fresh: impact.telemetryFresh,
    telemetry_watermark: impact.telemetryWatermark,
    requires_second_confirmation: impact.requiresSecondConfirmation,
    requires_confirmation: impact.requiresSecondConfirmation,
  };
}

export const deleteDeployment = (id: string, confirmation: DeleteConfirmation) => controllerApi.deleteControllerDeployment(id, {
  reason: confirmation.reason,
  confirmRecentTraffic: confirmation.confirm_recent_traffic,
  ...(confirmation.confirmation_name ? { confirmationName: confirmation.confirmation_name } : {}),
});

export async function createDeployment(input: {
  name: string;
  guardrail_id: string;
  integration_id?: string | null;
  traffic_scope: TrafficScopeExpression;
  enabled: boolean;
}): Promise<Deployment> {
  if (!input.integration_id) throw new Error("Controller 部署必须选择 Integration。");
  const created = await controllerApi.createControllerDeployment({
    name: input.name,
    guardrailId: input.guardrail_id,
    integrationId: input.integration_id,
    poolId: "default",
    trafficScope: input.traffic_scope,
    enabled: input.enabled,
  });
  const guardrail = await controllerApi.getControllerGuardrail(created.guardrailId);
  return mapDeployments([created], [guardrail])[0] as Deployment;
}

export async function createDeploymentBindings(input: {
  name: string;
  guardrail_id: string;
  integration_ids: string[];
  traffic_scope: TrafficScopeExpression;
  enabled: boolean;
}): Promise<Collection<Deployment>> {
  if (!input.integration_ids.length) return emptyCollection();
  const response = await controllerApi.requestController<{ items: controllerApi.Deployment[]; count: number }>("/api/v1/deployment-bindings", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      guardrailId: input.guardrail_id,
      integrationIds: input.integration_ids,
      poolId: "default",
      trafficScope: input.traffic_scope,
      enabled: input.enabled,
    }),
  });
  const guardrail = await controllerApi.getControllerGuardrail(input.guardrail_id);
  return { items: mapDeployments(response.items, [guardrail]), count: response.count };
}

export async function reorderDeploymentRoutes(integrationId: string, deploymentIds: string[]): Promise<Collection<Deployment>> {
  const response = await controllerApi.reorderControllerDeployments(integrationId, deploymentIds);
  const guardrails = await controllerApi.listControllerGuardrails();
  const items = mapDeployments(response.items, guardrails.items);
  return { items, count: items.length };
}
export async function setDeploymentEnabled(id: string, enabled: boolean): Promise<Deployment> {
  const item = await controllerApi.setControllerDeploymentEnabled(id, enabled);
  const guardrail = await controllerApi.getControllerGuardrail(item.guardrailId);
  return mapDeployments([item], [guardrail])[0]!;
}
export async function updateDeploymentTrafficScope(id: string, trafficScope: TrafficScopeExpression): Promise<Deployment> {
  const item = await controllerApi.updateControllerDeploymentTrafficScope(id, trafficScope);
  const guardrail = await controllerApi.getControllerGuardrail(item.guardrailId);
  return mapDeployments([item], [guardrail])[0]!;
}
export const getTrafficScopeFields = (): Promise<Collection<TrafficScopeField>> => controllerApi.requestController<Collection<TrafficScopeField>>("/api/v1/traffic-scope-fields");

export async function getDeploymentTraces(id: string, limit = 100): Promise<Collection<DeploymentRuntimeTrace>> {
  const events = await controllerApi.listRuntimeEvents(Math.min(10_000, Math.max(1, limit)), { deploymentId: id });
  const matching = events.items;
  return { items: matching.slice(0, limit).map(mapDeploymentTrace), count: matching.length };
}

function mapDeploymentTrace(event: controllerApi.RuntimeEvent): DeploymentRuntimeTrace {
  const outcome = normalizeOutcome(event.decision);
  const findings = runtimeFindings(event);
  const steps = runtimeTraceSteps(event);
  const usage = metadataRecord(event.metadata.usage);
  return {
    id: event.id,
    created_at: event.occurredAt,
    deployment_id: event.deploymentId ?? "",
    guardrail_id: event.guardrailId,
    guardrail_version: event.guardrailVersion,
    integration_id: event.integrationId,
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
