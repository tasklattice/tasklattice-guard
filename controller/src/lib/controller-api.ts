export type Collection<T> = { items: T[]; count?: number };

export type SystemStatus = {
  status: "ready" | "degraded";
  deploymentComplete: boolean;
  desiredGeneration: number;
  defaultRunnerReady: boolean;
  modelConnections: {
    controlPlane: { provider: string; model: string };
    dataPlane: {
      provider: string;
      models: Array<{ capability: "contentSafety" | "topicControl" | "jailbreak" | "grounding" | "automatedReasoning"; model: string }>;
    };
  };
};

export type GuardrailDraftConfig = {
  protections?: Array<"secrets" | "pii" | "builtin_content_filter" | "prompt_injection" | "jailbreak">;
  allowedTopics: string[];
  restrictedTopics: string[];
  policyBindings: Array<{
    policyId: string;
    policyVersion: string;
    action: "pass" | "redact" | "rewrite" | "regenerate" | "redirect" | "reject" | "fallback" | "clarify" | null;
    parameterValues: Record<string, string>;
    enabledRuleIds: string[];
    ruleActions: Record<string, "pass" | "redact" | "rewrite" | "regenerate" | "redirect" | "reject" | "fallback" | "clarify">;
    enabledRails: Array<"input" | "output" | "retrieval" | "dialog" | "execution">;
    reasoningPolicy: { policyId: string; policyVersion: string; confidenceThreshold: number } | null;
  }>;
  safetyLevel: "balanced" | "strict";
  outputDelivery: "interruptible" | "window_buffered" | "full_buffered";
};

export type Guardrail = {
  id: string;
  name: string;
  description: string;
  draftConfig: GuardrailDraftConfig;
  runtimeProfile: string;
  status: "draft" | "active" | "disabled";
  desiredGeneration: number;
  draftRevision: number;
  excludedTestCaseIds: string[];
  loggingLevel: "info" | "debug" | "trace";
  activeVersion: number | null;
  activeSourceDraftRevision: number | null;
  activeArtifactId: string | null;
  createdAt: string;
  updatedAt: string;
  latestValidationRun: ValidationRun | null;
  testCaseCount: number;
  excludedTestCaseCount: number;
};

export type GuardrailVersion = {
  guardrailId: string;
  version: number;
  generation: number;
  sourceDraftRevision: number;
  status: "compiling" | "ready" | "failed";
  runtimeProfile: string;
  plan: Record<string, unknown>;
  artifactId: string | null;
  failureReason: string | null;
  createdBy: string | null;
  createdAt: string;
  artifact?: GuardrailArtifact | null;
};

export type GuardrailArtifact = {
  id: string;
  compilerVersion: string;
  nemoVersion: string;
  runtimeProfile: string;
  plan: Record<string, unknown>;
  configYaml: string;
  colangContent: string;
  prompts: unknown[];
  actionBindings: unknown[];
  dependencyManifest: unknown[];
  checksum: string;
  signature: string;
  createdAt: string;
};

export type GuardrailDetail = Guardrail & { versions: GuardrailVersion[] };

export type GuardrailPlanPreview = {
  guardrail_id: string;
  candidate_version: number;
  engine: string;
  colang_version: string;
  compiler_version: string;
  checksum: string;
  rails: Array<{ rail_type: string; flow: string }>;
  parallel_groups: string[];
  actions: Array<{ name: string; version: string; flow: string; timeout_ms: number; failure_mode: string }>;
  models: string[];
  dependency_manifest: Array<{ kind: string; name: string; version: string }>;
  estimated_critical_path_ms: number;
};

export type Integration = {
  id: string;
  name: string;
  adapter: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
  credential?: string;
  desiredGeneration?: number;
  distributionStatus?: "ready" | "syncing";
};

export type Deployment = {
  id: string;
  name: string;
  guardrailId: string;
  integrationId: string | null;
  poolId: string;
  guardrailVersion: number | null;
  routeOrder: number;
  enabled: boolean;
  trafficScope: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ValidationRun = {
  id: string;
  guardrailId: string;
  guardrailVersion: number | null;
  sourceDraftRevision: number;
  status: "queued" | "running" | "passed" | "failed";
  metrics: {
    total: number;
    passed: number;
    complianceRate: number;
    falsePositiveRate: number;
    falseNegativeRate: number;
    deepEscalationRate: number;
    p95LatencyMs: number;
  };
  results: Array<Record<string, unknown>>;
  excludedCaseIds: string[];
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type RunnerLoad = {
  inflight: number;
  maxConcurrency: number;
  queueDepth: number;
  requestsDelta: number;
  errorsDelta: number;
  timeoutsDelta: number;
  latencyP95Ms: number;
  cpuUtilization: number;
  memoryUtilization: number;
  activeGuardrails: number;
  compileQueueDepth: number;
  observationIntervalMs: number;
};

export type RunnerInstance = {
  runnerId: string;
  bootId: string;
  poolId: string;
  status: "registered" | "syncing" | "ready" | "busy" | "saturated" | "offline";
  runnerVersion: string;
  nemoVersion: string;
  compilerCapable: boolean;
  maxConcurrency: number;
  desiredGeneration: number;
  appliedGeneration: number;
  load: RunnerLoad | null;
  lastHeartbeatAt: string;
};

export type PoolCapacity = {
  readyRunners: number;
  totalRunners: number;
  currentRps: number;
  safeRpsCapacity: number;
  utilization: number;
  inflightUtilization: number;
  cpuUtilization: number;
  memoryUtilization: number;
  queueDepth: number;
  errorRate: number;
  worstRunnerLatencyP95Ms: number;
  latencyP95Ms: number;
  recommendedReplicas: number;
  headroomRps: number;
};

export type RunnerPool = {
  id: string;
  name: string;
  isDefault: boolean;
  desiredReplicas: number;
  safeRpsPerRunner: number;
  maxConcurrencyPerRunner: number;
  instances: RunnerInstance[];
  capacity: PoolCapacity;
};

export type DeletionImpact = {
  resourceId: string;
  windowMinutes: number;
  incomingRequestCount: number;
  lastRequestAt: string | null;
  activeDeploymentCount: number;
  telemetryFresh: boolean;
  telemetryWatermark: string | null;
  requiresSecondConfirmation: boolean;
};

export type RuntimeEvent = {
  id: string;
  occurredAt: string;
  requestId: string;
  runnerId: string;
  guardrailId: string | null;
  guardrailVersion: number | null;
  integrationId: string | null;
  deploymentId: string | null;
  direction: "incoming" | "outgoing";
  decision: string;
  durationMs: number;
  metadata: Record<string, unknown>;
};

export type AuditEvent = {
  id: string;
  kind: string;
  actorId: string | null;
  resourceType: string;
  resourceId: string;
  detail: Record<string, unknown>;
  occurredAt: string;
};

export async function requestController<T>(path: string, init?: RequestInit): Promise<T> {
  const formData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: init?.body && !formData ? { "content-type": "application/json", ...init.headers } : init?.headers,
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({})) as { error?: { message?: string; detail?: unknown }; detail?: unknown; message?: string };
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new CustomEvent("tasklattice:unauthorized"));
    throw new Error(formatApiError(payload.error?.detail ?? payload.error?.message ?? payload.detail ?? payload.message, response.status));
  }
  return payload as T;
}

function formatApiError(detail: unknown, status: number): string {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const issue = item as { loc?: unknown; msg?: unknown; message?: unknown };
      const message = typeof issue.msg === "string" ? issue.msg : typeof issue.message === "string" ? issue.message : "";
      const location = Array.isArray(issue.loc)
        ? issue.loc.filter((part) => part !== "body").map(String).join(".")
        : "";
      return message ? `${location ? `${location}: ` : ""}${message}` : "";
    }).filter(Boolean);
    if (messages.length) return messages.join("; ");
  }
  if (detail && typeof detail === "object") {
    const issue = detail as { msg?: unknown; message?: unknown };
    if (typeof issue.msg === "string" && issue.msg) return issue.msg;
    if (typeof issue.message === "string" && issue.message) return issue.message;
  }
  return `Request failed with status ${status}.`;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const getControllerSystemStatus = async () => {
  const response = await fetch("/api/v1/system/status", { credentials: "same-origin" });
  if (response.status === 200 || response.status === 503) return response.json() as Promise<SystemStatus>;
  throw new Error(`System status failed with status ${response.status}.`);
};
export const listControllerGuardrails = () => requestController<Collection<Guardrail>>("/api/v1/guardrails");
export const getControllerGuardrail = (id: string) => requestController<GuardrailDetail>(`/api/v1/guardrails/${encodeURIComponent(id)}`);
export const createControllerGuardrail = (input: Pick<Guardrail, "name" | "description" | "draftConfig" | "runtimeProfile">) => requestController<Guardrail>("/api/v1/guardrails", json("POST", input));
export const previewControllerGuardrailPlan = (input: Pick<Guardrail, "name" | "description" | "draftConfig" | "runtimeProfile">) => requestController<GuardrailPlanPreview>("/api/v1/guardrail-plan-previews", json("POST", input));
export const updateControllerGuardrail = (id: string, input: Partial<Pick<Guardrail, "name" | "description" | "draftConfig" | "runtimeProfile">>) => requestController<Guardrail>(`/api/v1/guardrails/${encodeURIComponent(id)}`, json("PATCH", input));
export const publishControllerGuardrail = (id: string) => requestController<{ status: string; version: number }>(`/api/v1/guardrails/${encodeURIComponent(id)}/publish`, json("POST"));
export const rollbackControllerGuardrail = (id: string, version: number) => requestController<GuardrailVersion>(`/api/v1/guardrails/${encodeURIComponent(id)}/rollback/${version}`, json("POST"));
export const getControllerGuardrailDeletionImpact = (id: string) => requestController<DeletionImpact>(`/api/v1/guardrails/${encodeURIComponent(id)}/deletion-impact`);
export const deleteControllerGuardrail = (id: string, input: { reason: string; confirmRecentTraffic: boolean; confirmationName?: string | undefined }) => requestController<void>(`/api/v1/guardrails/${encodeURIComponent(id)}`, json("DELETE", input));

export const listControllerIntegrations = () => requestController<Collection<Integration>>("/api/v1/integrations");
export const createControllerIntegration = (input: { name: string; adapter: string }) => requestController<Integration>("/api/v1/integrations", json("POST", input));
export const getControllerIntegrationDeletionImpact = (id: string) => requestController<DeletionImpact>(`/api/v1/integrations/${encodeURIComponent(id)}/deletion-impact`);
export const deleteControllerIntegration = (id: string, input: { reason: string; confirmRecentTraffic: boolean; confirmationName?: string | undefined }) => requestController<void>(`/api/v1/integrations/${encodeURIComponent(id)}`, json("DELETE", input));

export const listControllerDeployments = () => requestController<Collection<Deployment>>("/api/v1/deployments");
export const createControllerDeployment = (input: Pick<Deployment, "name" | "guardrailId" | "poolId" | "trafficScope" | "enabled"> & { integrationId: string }) => requestController<Deployment>("/api/v1/deployments", json("POST", input));
export const getControllerDeploymentDeletionImpact = (id: string) => requestController<DeletionImpact>(`/api/v1/deployments/${encodeURIComponent(id)}/deletion-impact`);
export const deleteControllerDeployment = (id: string, input: { reason: string; confirmRecentTraffic: boolean; confirmationName?: string | undefined }) => requestController<void>(`/api/v1/deployments/${encodeURIComponent(id)}`, json("DELETE", input));
export const setControllerDeploymentEnabled = (id: string, enabled: boolean) => requestController<Deployment>(`/api/v1/deployments/${encodeURIComponent(id)}`, json("PATCH", { enabled }));
export const updateControllerDeploymentTrafficScope = (id: string, trafficScope: Record<string, unknown>) => requestController<Deployment>(`/api/v1/deployments/${encodeURIComponent(id)}/traffic-scope`, json("PUT", { trafficScope }));
export const reorderControllerDeployments = (integrationId: string, deploymentIds: string[]) => requestController<Collection<Deployment>>(`/api/v1/integrations/${encodeURIComponent(integrationId)}/deployment-order`, json("PUT", { deploymentIds }));
export const listRunnerPools = () => requestController<Collection<RunnerPool>>("/api/v1/runner-pools");
export const updateRunnerPool = (id: string, input: Pick<RunnerPool, "desiredReplicas" | "safeRpsPerRunner" | "maxConcurrencyPerRunner">) => requestController<RunnerPool>(`/api/v1/runner-pools/${encodeURIComponent(id)}`, json("PATCH", input));
export const removeRunnerInstance = (runnerId: string) => requestController<void>(`/api/v1/runner-instances/${encodeURIComponent(runnerId)}`, json("DELETE"));
export const listRuntimeEvents = (limit = 100, filters: { guardrailId?: string; deploymentId?: string; integrationId?: string; since?: string; before?: string } = {}) => {
  const query = new URLSearchParams({ limit: String(Math.min(10_000, Math.max(1, limit))) });
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  return requestController<Collection<RuntimeEvent>>(`/api/v1/runtime-events?${query.toString()}`);
};
export const listAuditEvents = (limit = 100) => requestController<Collection<AuditEvent>>(`/api/v1/audit-events?limit=${Math.min(500, Math.max(1, limit))}`);
