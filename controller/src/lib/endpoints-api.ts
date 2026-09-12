import * as controllerApi from "@/lib/controller-api";
import { normalizeOutcome } from "@/lib/controller-api-mappers";
import type {
  Collection,
  DeleteConfirmation,
  Endpoint,
  EndpointAdapterId,
  EndpointDeletionImpact,
  EndpointRegistration,
  OneTimeEndpointCredential,
} from "@/lib/api-types";

type CurrentCredential = { id: string; keyHint: string; createdAt: string };
type CurrentEndpoint = controllerApi.Endpoint & {
  credentials?: CurrentCredential[];
  setup?: Endpoint["setup"];
  credentialId?: string;
  credentialKeyHint?: string;
  credentialCreatedAt?: string;
  desiredGeneration?: number;
  distributionStatus?: "ready" | "syncing";
};

function endpointAdapter(adapter: string): { id: EndpointAdapterId; protocol: "litellm" | "http" | "a2a" } {
  const normalized = adapter.toLowerCase();
  if (normalized.includes("litellm")) return { id: "litellm-generic-guardrail", protocol: "litellm" };
  if (normalized.includes("a2a")) return { id: "a2a-guard", protocol: "a2a" };
  if (normalized === "http" || normalized === "generic-http-guard") return { id: "generic-http-guard", protocol: "http" };
  throw new Error(`Unknown Endpoint adapter: ${adapter}`);
}

function endpointSetup(): Endpoint["setup"] {
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

function endpointEvents(value: controllerApi.Endpoint, events: controllerApi.RuntimeEvent[]): controllerApi.RuntimeEvent[] {
  return events.filter((event) => event.endpointId === value.id);
}

type EndpointActivity = Pick<Endpoint, 'first_seen_at' | 'last_seen_at' | 'input_seen_at' | 'output_seen_at' | 'stream_final_check_seen_at' | 'last_error_at' | 'request_count' | 'error_count' | 'detection_p95_ms'> & { id: string };
const getActivity = () => controllerApi.requestController<{ items: EndpointActivity[] }>('/api/v1/telemetry/endpoint-activity');

function mapEndpoint(value: CurrentEndpoint, events: controllerApi.RuntimeEvent[], activity?: EndpointActivity): Endpoint {
  const adapter = endpointAdapter(value.adapter);
  const matching = endpointEvents(value, events);
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
        : activity?.last_seen_at || matching.length
          ? "verified"
          : "awaiting_callback",
    desired_generation: value.desiredGeneration,
    runtime_status: errors.length ? "degraded" : matching.length ? "healthy" : "unknown",
    first_seen_at: timestamps[0] ?? null,
    input_seen_at: incoming[0] ?? null,
    output_seen_at: outgoing[0] ?? null,
    stream_final_check_seen_at: matching.filter((event) => event.metadata?.streamFinalCheck === true)
      .map((event) => event.occurredAt).sort().at(-1) ?? null,
    last_seen_at: timestamps.at(-1) ?? null,
    last_error_at: errors.map((event) => event.occurredAt).sort().at(-1) ?? null,
    request_count: new Set(matching.map((event) => event.requestId)).size,
    error_count: errors.length,
    setup: value.setup ?? endpointSetup(),
    created_at: value.createdAt,
    updated_at: value.updatedAt,
    ...(activity ? { ...activity, runtime_status: activity.error_count ? 'degraded' as const : activity.request_count > 0 ? 'healthy' as const : 'unknown' as const } : {}),
  };
}

export async function getEndpoints(): Promise<Collection<Endpoint>> {
  const [endpoints, events] = await Promise.all([
    controllerApi.listControllerEndpoints(),
    getActivity(),
  ]);
  const activity = new Map(events.items.map(item=>[item.id,item]));
  const items = endpoints.items.map((item) => mapEndpoint(item as CurrentEndpoint, [], activity.get(item.id)));
  return { items, count: items.length };
}

export async function getEndpoint(id: string): Promise<Endpoint> {
  const [endpoint, events] = await Promise.all([
    controllerApi.requestController<CurrentEndpoint>(`/api/v1/endpoints/${encodeURIComponent(id)}`),
    getActivity(),
  ]);
  return mapEndpoint(endpoint, [], events.items.find(item=>item.id===id));
}

function oneTimeRegistration(value: CurrentEndpoint): EndpointRegistration {
  if (!value.credential) throw new Error("Controller did not return the one-time Endpoint credential.");
  const credential: OneTimeEndpointCredential = {
    id: value.credentialId ?? "",
    key_hint: value.credentialKeyHint ?? credentialHint(value.credential),
    created_at: value.credentialCreatedAt ?? value.createdAt,
    value: value.credential,
  };
  const credentials = value.credentials?.length
    ? value.credentials
    : [{ id: credential.id, keyHint: credential.key_hint, createdAt: credential.created_at }];
  return {
    endpoint: mapEndpoint({ ...value, credentials }, []),
    credential,
  };
}

export async function createEndpoint(input: { name: string; adapter_id: EndpointAdapterId }): Promise<EndpointRegistration> {
  const created = await controllerApi.createControllerEndpoint({ name: input.name, adapter: input.adapter_id }) as CurrentEndpoint;
  return oneTimeRegistration(created);
}

export async function setEndpointEnabled(id: string, enabled: boolean): Promise<Endpoint> {
  const updated = await controllerApi.requestController<CurrentEndpoint>(`/api/v1/endpoints/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
  const events = await getActivity();
  return mapEndpoint(updated, [], events.items.find(item=>item.id===id));
}

export async function rotateEndpointCredential(id: string): Promise<EndpointRegistration> {
  const updated = await controllerApi.requestController<CurrentEndpoint>(`/api/v1/endpoints/${encodeURIComponent(id)}/credentials`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  return oneTimeRegistration(updated);
}

export const revokeEndpointCredential = (endpointId: string, credentialId: string) => controllerApi.requestController<void>(
  `/api/v1/endpoints/${encodeURIComponent(endpointId)}/credentials/${encodeURIComponent(credentialId)}`,
  { method: "DELETE" },
);

export async function getEndpointDeletionImpact(id: string): Promise<EndpointDeletionImpact> {
  const [impact, endpoint] = await Promise.all([
    controllerApi.getControllerEndpointDeletionImpact(id),
    controllerApi.requestController<CurrentEndpoint>(`/api/v1/endpoints/${encodeURIComponent(id)}`),
  ]);
  return {
    endpoint_id: impact.resourceId,
    endpoint_name: endpoint.name,
    window_minutes: impact.windowMinutes,
    incoming_request_count: impact.incomingRequestCount,
    last_request_at: impact.lastRequestAt,
    active_router_count: impact.activeRouterCount,
    active_credential_count: endpoint.credentials?.length ?? 0,
    telemetry_fresh: impact.telemetryFresh,
    telemetry_watermark: impact.telemetryWatermark,
    requires_second_confirmation: impact.requiresSecondConfirmation,
    requires_confirmation: impact.requiresSecondConfirmation,
  };
}

export const deleteEndpoint = (id: string, confirmation: DeleteConfirmation) => controllerApi.deleteControllerEndpoint(id, {
  reason: confirmation.reason,
  confirmRecentTraffic: confirmation.confirm_recent_traffic,
  ...(confirmation.confirmation_name ? { confirmationName: confirmation.confirmation_name } : {}),
});

function credentialHint(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}
