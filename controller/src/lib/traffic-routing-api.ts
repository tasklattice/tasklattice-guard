import { requestController, type Collection, type GuardrailDetail } from './controller-api';
import type { RouterChangeRequest, RouterDraft, TrafficRouter, SelectorField } from '../../shared/traffic-routing';
export type { RouterChangeRequest, RouterChangeRequestStatus, RouterDraft, TrafficRouter, TrafficRoute, RouteTarget, SelectorExpression, SelectorCondition, RoutingInput, SelectorField } from '../../shared/traffic-routing';
export const trafficRouterKeys = { all: ['traffic-routers'] as const, detail: (id: string) => ['traffic-routers', id] as const };
const path = (id: string) => `/api/v1/routers/${encodeURIComponent(id)}`;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
export const listTrafficRouters = () => requestController<Collection<TrafficRouter>>('/api/v1/routers');
export const getTrafficRouter = (id: string) => requestController<TrafficRouter>(path(id));
export const createTrafficRouter = (input: { name: string; description?: string; endpointIds?: string[]; draft: RouterDraft }) => requestController<TrafficRouter>('/api/v1/routers', json('POST', input));
export const saveTrafficRouter = (id: string, expectedDraftRevision: number, draft: RouterDraft) => requestController<TrafficRouter>(`${path(id)}/draft`, json('PUT', { expectedDraftRevision, draft }));
const change = (id: string, changeId: string) => `${path(id)}/change-requests/${encodeURIComponent(changeId)}`;
export const listRouterChangeRequests = (id: string) => requestController<Collection<RouterChangeRequest>>(`${path(id)}/change-requests`);
export const submitRouterChange = (id: string, input: { expectedDraftRevision: number; reviewedSnapshot: RouterDraft; reviewedEndpointIds: string[]; reason: string; ticket: string }) => requestController<RouterChangeRequest>(`${path(id)}/change-requests`, json('POST', input));
export const approveRouterChange = (id: string, changeId: string, note?: string) => requestController<TrafficRouter>(`${change(id, changeId)}/approve`, json('POST', note ? { note } : {}));
export const emergencyApplyRouterChange = (id: string, changeId: string, input: { reason: string; managerContact: string }) => requestController<TrafficRouter>(`${change(id, changeId)}/emergency-apply`, json('POST', input));
export const rejectRouterChange = (id: string, changeId: string, note: string) => requestController<RouterChangeRequest>(`${change(id, changeId)}/reject`, json('POST', { note }));
export const withdrawRouterChange = (id: string, changeId: string) => requestController<RouterChangeRequest>(`${change(id, changeId)}/withdraw`, { method: 'POST' });
export const revertRouterChange = (id: string, changeId: string, reason: string) => requestController<TrafficRouter>(`${change(id, changeId)}/revert`, json('POST', { reason }));
export const bindTrafficRouter = (id: string, endpointIds: string[]) => requestController<TrafficRouter>(`${path(id)}/endpoints`, json('PUT', { endpointIds }));
/** Publish-time metadata only; null/absent means unknown, never resolve from current entities. */
export type RouterRevisionContext = {
  endpoints: Array<{ id: string; name: string; adapter: string }>;
  guardrails: Array<{ id: string; name: string; version: string }>;
};
export type RouterRevision = { revision: number; sourceDraftRevision: number; snapshot: RouterDraft; context?: RouterRevisionContext | null; createdAt: string; createdBy: string | null; changeRequestId?: string | null };
export const getRouterRevisions = (id: string) => requestController<Collection<RouterRevision>>(`${path(id)}/revisions`);
export type DistributionRow = { routeId: string | null; targetId: string | null; routerRevision: number | null; guardrailId: string | null; guardrailVersion: string | null; assignmentStatus: "assigned" | "unassigned"; inferredCompletions: number; count: number; errors: number; completed: number; blocked: number; transformed: number; intervened: number; allowed: number; p95Ms: number | null };
export type DistributionReport = { since: string; until: string; rows: DistributionRow[]; total: number; assigned?: number; unassigned?: number; dataWatermark: string | null; unit: string; multipleRevisions: boolean; freshness?: string; telemetryFresh: boolean; completeness: string; revisions: Array<{ revision: number; snapshot: RouterDraft; context?: RouterRevisionContext | null }>; trend?: Array<{ at: string; routeId: string | null; count: number }> };
export const getRouterDistribution = (id: string, hours = 24, revision?: number, endpointId?: string) => {
  const query = new URLSearchParams({ hours: String(hours) });
  if (revision) query.set('revision', String(revision));
  if (endpointId) query.set('endpointId', endpointId);
  return requestController<DistributionReport>(`${path(id)}/traffic-distribution?${query}`);
};
export const getSelectorFields = (endpointIds: string[]) => requestController<Collection<SelectorField> & { capabilities?: unknown }>('/api/v1/routing/selector-fields?' + new URLSearchParams({ endpointIds: endpointIds.join(',') }));
export type DuplicateSource = { sourceVersion: string; sourceDraftRevision?: never } | { sourceDraftRevision: number; sourceVersion?: never };
export const duplicateGuardrail = (id: string, name: string, source: DuplicateSource, idempotencyKey: string) => requestController<GuardrailDetail>(`/api/v1/guardrails/${encodeURIComponent(id)}/duplicate`, json('POST', { name, ...source, idempotencyKey }));

export const deleteTrafficRouter = (id: string) => requestController<void>(path(id), { method: "DELETE" });

export type RouterPublicationPreview = { draftRevision: number; snapshot: RouterDraft; endpointIds: string[] };
export const previewTrafficRouter = (id: string, expectedDraftRevision: number) => requestController<RouterPublicationPreview>(`${path(id)}/publication-preview`, json("POST", { expectedDraftRevision }));

export const deleteRouterRevision = (id: string, revision: number) => requestController<void>(`${path(id)}/revisions/${revision}`, { method: "DELETE" });
