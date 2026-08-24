import * as controllerApi from "@/lib/controller-api";
import { normalizeOutcome } from "@/lib/controller-api-mappers";
import type {
  Collection,
  DeleteConfirmation,
  Integration,
  IntegrationAdapterId,
  IntegrationDeletionImpact,
  IntegrationRegistration,
  OneTimeIntegrationCredential,
} from "@/lib/api-types";

type CurrentCredential = { id: string; keyHint: string; createdAt: string };
type CurrentIntegration = controllerApi.Integration & {
  credentials?: CurrentCredential[];
  setup?: Integration["setup"];
  credentialId?: string;
  credentialKeyHint?: string;
  credentialCreatedAt?: string;
  desiredGeneration?: number;
  distributionStatus?: "ready" | "syncing";
};

function integrationAdapter(adapter: string): { id: IntegrationAdapterId; protocol: "litellm" | "http" | "a2a" } {
  const normalized = adapter.toLowerCase();
  if (normalized.includes("litellm")) return { id: "litellm-generic-guardrail", protocol: "litellm" };
  if (normalized.includes("a2a")) return { id: "a2a-guard", protocol: "a2a" };
  if (normalized === "http" || normalized === "generic-http-guard") return { id: "generic-http-guard", protocol: "http" };
  throw new Error(`Unknown Integration adapter: ${adapter}`);
}

function integrationSetup(): Integration["setup"] {
  return {
    api_base_url: "",
    callback_url: "",
    auth_header: "x-api-key",
    credential_env_var: "",
    api_base_env_var: "",
    recommended_modes: [],
    default_on: false,
    fail_on_error: true,
    unreachable_fallback: "fail_closed",
    yaml_template: "",
  };
}

function mapCredential(value: CurrentCredential) {
  return { id: value.id, key_hint: value.keyHint, created_at: value.createdAt };
}

function integrationEvents(value: controllerApi.Integration, events: controllerApi.RuntimeEvent[]): controllerApi.RuntimeEvent[] {
  return events.filter((event) => event.integrationId === value.id);
}

function mapIntegration(value: CurrentIntegration, events: controllerApi.RuntimeEvent[]): Integration {
  const adapter = integrationAdapter(value.adapter);
  const matching = integrationEvents(value, events);
  const incoming = matching.filter((event) => event.direction === "incoming").map((event) => event.occurredAt).sort();
  const outgoing = matching.filter((event) => event.direction === "outgoing").map((event) => event.occurredAt).sort();
  const errors = matching.filter((event) => normalizeOutcome(event.decision) === "error");
  const timestamps = matching.map((event) => event.occurredAt).sort();
  const credentials = (value.credentials ?? []).map(mapCredential);
  return {
    id: value.id,
    adapter_id: adapter.id,
    protocol: adapter.protocol,
    name: value.name,
    description: "",
    enabled: value.status === "active",
    key_hint: credentials[0]?.key_hint ?? "",
    credentials,
    setup_status: value.status === "disabled"
      ? "disabled"
      : value.distributionStatus === "syncing"
        ? "applying"
        : matching.length
          ? "verified"
          : "awaiting_callback",
    desired_generation: value.desiredGeneration,
    runtime_status: errors.length ? "degraded" : matching.length ? "healthy" : "unknown",
    first_seen_at: timestamps[0] ?? null,
    input_seen_at: incoming[0] ?? null,
    output_seen_at: outgoing[0] ?? null,
    last_seen_at: timestamps.at(-1) ?? null,
    last_error_at: errors.map((event) => event.occurredAt).sort().at(-1) ?? null,
    request_count: new Set(matching.map((event) => event.requestId)).size,
    error_count: errors.length,
    setup: value.setup ?? integrationSetup(),
    created_at: value.createdAt,
    updated_at: value.updatedAt,
  };
}

export async function getIntegrations(): Promise<Collection<Integration>> {
  const [integrations, events] = await Promise.all([
    controllerApi.listControllerIntegrations(),
    controllerApi.listRuntimeEvents(500),
  ]);
  const items = integrations.items.map((item) => mapIntegration(item as CurrentIntegration, events.items));
  return { items, count: items.length };
}

export async function getIntegration(id: string): Promise<Integration> {
  const [integration, events] = await Promise.all([
    controllerApi.requestController<CurrentIntegration>(`/api/v1/integrations/${encodeURIComponent(id)}`),
    controllerApi.listRuntimeEvents(500),
  ]);
  return mapIntegration(integration, events.items);
}

function oneTimeRegistration(value: CurrentIntegration): IntegrationRegistration {
  if (!value.credential) throw new Error("Controller did not return the one-time Integration credential.");
  const credential: OneTimeIntegrationCredential = {
    id: value.credentialId ?? "",
    key_hint: value.credentialKeyHint ?? credentialHint(value.credential),
    created_at: value.credentialCreatedAt ?? value.createdAt,
    value: value.credential,
  };
  const credentials = value.credentials?.length
    ? value.credentials
    : [{ id: credential.id, keyHint: credential.key_hint, createdAt: credential.created_at }];
  return {
    integration: mapIntegration({ ...value, credentials }, []),
    credential,
  };
}

export async function createIntegration(input: { name: string; adapter_id: IntegrationAdapterId }): Promise<IntegrationRegistration> {
  const created = await controllerApi.createControllerIntegration({ name: input.name, adapter: input.adapter_id }) as CurrentIntegration;
  return oneTimeRegistration(created);
}

export async function setIntegrationEnabled(id: string, enabled: boolean): Promise<Integration> {
  const updated = await controllerApi.requestController<CurrentIntegration>(`/api/v1/integrations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
  const events = await controllerApi.listRuntimeEvents(500);
  return mapIntegration(updated, events.items);
}

export async function rotateIntegrationCredential(id: string): Promise<IntegrationRegistration> {
  const updated = await controllerApi.requestController<CurrentIntegration>(`/api/v1/integrations/${encodeURIComponent(id)}/credentials`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  return oneTimeRegistration(updated);
}

export const revokeIntegrationCredential = (integrationId: string, credentialId: string) => controllerApi.requestController<void>(
  `/api/v1/integrations/${encodeURIComponent(integrationId)}/credentials/${encodeURIComponent(credentialId)}`,
  { method: "DELETE" },
);

export async function getIntegrationDeletionImpact(id: string): Promise<IntegrationDeletionImpact> {
  const [impact, integration] = await Promise.all([
    controllerApi.getControllerIntegrationDeletionImpact(id),
    controllerApi.requestController<CurrentIntegration>(`/api/v1/integrations/${encodeURIComponent(id)}`),
  ]);
  return {
    integration_id: impact.resourceId,
    integration_name: integration.name,
    window_minutes: impact.windowMinutes,
    incoming_request_count: impact.incomingRequestCount,
    last_request_at: impact.lastRequestAt,
    active_deployment_count: impact.activeDeploymentCount,
    active_credential_count: integration.credentials?.length ?? 0,
    telemetry_fresh: impact.telemetryFresh,
    telemetry_watermark: impact.telemetryWatermark,
    requires_second_confirmation: impact.requiresSecondConfirmation,
    requires_confirmation: impact.requiresSecondConfirmation,
  };
}

export const deleteIntegration = (id: string, confirmation: DeleteConfirmation) => controllerApi.deleteControllerIntegration(id, {
  reason: confirmation.reason,
  confirmRecentTraffic: confirmation.confirm_recent_traffic,
  ...(confirmation.confirmation_name ? { confirmationName: confirmation.confirmation_name } : {}),
});

function credentialHint(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}
