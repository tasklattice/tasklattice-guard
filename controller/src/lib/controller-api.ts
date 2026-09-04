import type { EnforcementAction } from "../../shared/enforcement-action.generated";
import type {
  GuardrailLifecycleState,
  GuardrailVersionState,
  IntegrationLifecycleState,
  RunnerStatus,
  ValidationRunState,
} from "../../shared/lifecycle";
import type { ModelDetectorType } from "../../shared/guardrail-catalog";

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
      models: Array<{ id: string; model: string }>;
    };
  };
};

export type ModelProviderKind = "openai" | "qwen" | "deepseek" | "vllm" | "ollama" | "custom-openai-compatible";
export type ModelProfile = "generic-chat" | "tali.qwen3guard.v1" | "tali.llama-guard-3.v1" | "tali.nemotron-content-safety.v1" | "tali.nemotron-safety-guard-v3.v1" | "tali.nemoguard-topic-control.v1" | "tali.openai-compatible-jailbreak.v1" | "tali.nemoguard-jailbreak-detect.v1" | "tali.taxonomy-judge.v1" | "tali.grounding-judge.v1" | "tali.automated-reasoning.v1";
export type { ModelDetectorType };
export type ModelAssignments = {
  controlPlane: string | null;
  detectors: Record<ModelDetectorType, string | null>;
};

export type ModelProvider = {
  skipTlsVerify?: boolean;
  id: string;
  name: string;
  kind: ModelProviderKind;
  baseUrl: string;
  credentialHint: string | null;
  credentialConfigured: boolean;
  status: "pending" | "validated" | "failed";
  validationMessage: string | null;
  validationLatencyMs: number | null;
  validatedAt: string | null;
};

export type DiscoveredProviderModels = {
  providerId: string;
  providerName: string;
  models: Array<{ id: string; name: string }>;
};

export type ModelDefinition = {
  protocolEditable?: boolean;
  connectionStatus?: "pending" | "validated" | "failed";
  connectionMessage?: string | null;
  connectionLatencyMs?: number | null;
  connectionCheckedAt?: string | null;
  id: string;
  providerId: string;
  providerName: string;
  providerKind: ModelProviderKind;
  name: string;
  model: string;
  profile: ModelProfile;
  timeoutSeconds: number;
  maxTokens: number;
  status: "pending" | "validated" | "failed";
  validationMessage: string | null;
  validationLatencyMs: number | null;
  validatedAt: string | null;
};

export type ModelValidationReport = {
  valid: boolean;
  checkedAt: string;
  checks: Array<{
    id: string;
    scope: "configuration" | "provider" | "model" | "detector";
    status: "passed" | "failed" | "skipped";
    message: string;
    latencyMs?: number;
  }>;
  contractCoverage: Array<{ contract: string; source: "local" | "model"; modelId: string | null; detectorType: ModelDetectorType | null }>;
  policies: Array<{ id: string; name: string; status: "ready" | "blocked"; missingContracts: string[] }>;
};

export type ModelConfigurationRevision = {
  id: string;
  revision: number;
  state: "draft" | "validated" | "activating" | "active" | "superseded" | "failed";
  generation: number | null;
  assignments: ModelAssignments;
  validationReport: ModelValidationReport | null;
  failureReason: string | null;
  validatedAt: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ModelConfigurationView = {
  providers: ModelProvider[];
  models: ModelDefinition[];
  draft: ModelConfigurationRevision;
  active: ModelConfigurationRevision | null;
  activating: ModelConfigurationRevision | null;
  failed: ModelConfigurationRevision | null;
};

export type GuardrailDraftConfig = {
  purposeDetails: {
    audience: string;
    tasks: string;
    protect: string;
    outOfScope: string;
  };
  allowedTopics: string[];
  restrictedTopics: string[];
  policyBindings: Array<{
    policyId: string;
    policyVersion: string;
    action: EnforcementAction | null;
    parameterValues: Record<string, string>;
    enabledRuleIds: string[];
    ruleActions: Record<string, EnforcementAction>;
    ruleOrder?: string[];
    testCaseOverrides?: Record<string, {
      sourcePolicyVersion: string; reason: string;
      expectedDecision: "allow" | "block" | "transform" | "intervene";
      expectedOutputContent?: string;
      expectedMatches: Array<{ policyId: string; ruleId: string }>;
    }>;
    enabledRails: Array<"input" | "output" | "retrieval" | "dialog" | "execution">;
    reasoningPolicy: { policyId: string; policyVersion: string; confidenceThreshold: number } | null;
  }>;
  safetyLevel: "balanced" | "strict";
  outputDelivery: "interruptible" | "window_buffered" | "full_buffered";
  customContentRules?: Array<{
    id: string;
    phases: Array<"input" | "output">;
    detector: "keyword" | "regex";
    keywords?: string[];
    expression?: string;
    action: "pass" | "redact" | "rewrite" | "regenerate" | "redirect" | "reject" | "fallback" | "clarify";
    replacement?: string;
  }>;
};

export type Guardrail = {
  id: string;
  name: string;
  description: string;
  draftConfig: GuardrailDraftConfig;
  runtimeProfile: string;
  status: GuardrailLifecycleState;
  desiredGeneration: number;
  draftRevision: number;
  excludedTestCaseIds: string[];
  loggingLevel: "info" | "debug" | "trace";
  activeVersion: string | null;
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
  version: string;
  generation: number;
  sourceDraftRevision: number;
  status: GuardrailVersionState;
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
  candidate_version: string;
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
  status: IntegrationLifecycleState;
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
  guardrailVersion: string | null;
  routeOrder: number;
  enabled: boolean;
  trafficScope: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ValidationRun = {
  id: string;
  guardrailId: string;
  guardrailVersion: string;
  sourceDraftRevision: number;
  status: ValidationRunState;
  metrics: {
    total: number;
    passed: number;
    complianceRate: number;
    falsePositiveRate: number;
    falseNegativeRate: number;
    escalationRate: number;
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
  status: RunnerStatus;
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
  guardrailVersion: string | null;
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
export const getModelConfiguration = async () => {
  const view = await requestController<ModelConfigurationView>("/api/v1/model-configuration");
  if (!view.draft?.assignments?.detectors) {
    throw new Error("The Controller is serving an incompatible legacy Model configuration. Deploy the matching Controller backend before using Guardrail Catalog.");
  }
  return view;
};
export type ProviderConnectionDraft = { name: string; kind: ModelProviderKind; baseUrl: string; apiKey: string; skipTlsVerify?: boolean };
export type ProviderModelSelection = { name: string; model: string; profile: ModelProfile; timeoutSeconds: number; maxTokens: number };
export type ProviderRegistrationResult = { provider: ModelProvider; models: ModelDefinition[]; failures: Array<{ model: ProviderModelSelection; message: string }> };
export const discoverProviderDraft = (input: ProviderConnectionDraft) => requestController<Omit<DiscoveredProviderModels, "providerId">>("/api/v1/model-providers/discover", json("POST", input));
export const registerProviderModels = (input: { connection: ProviderConnectionDraft; models: ProviderModelSelection[] }) => requestController<ProviderRegistrationResult>("/api/v1/model-providers/register", json("POST", input));
export const createModelProvider = (input: { name: string; kind: ModelProviderKind; baseUrl: string; apiKey?: string; skipTlsVerify?: boolean }) => requestController<ModelProvider>("/api/v1/model-providers", json("POST", input));
export const updateProviderTls = (id: string, skipTlsVerify: boolean) => requestController<ModelProvider>(`/api/v1/model-providers/${encodeURIComponent(id)}`, json("PATCH", { skipTlsVerify }));
export const revalidateModelProvider = (id: string) => requestController<ModelProvider>(`/api/v1/model-providers/${encodeURIComponent(id)}/validate`, json("POST"));
export const discoverModelProvider = (id: string) => requestController<DiscoveredProviderModels>(`/api/v1/model-providers/${encodeURIComponent(id)}/discover`, json("POST"));
export const deleteModelProvider = (id: string) => requestController<void>(`/api/v1/model-providers/${encodeURIComponent(id)}`, json("DELETE"));
export const createModelDefinition = (input: { providerId: string; name: string; model: string; profile: ModelProfile; timeoutSeconds: number; maxTokens: number }) => requestController<ModelDefinition>("/api/v1/models", json("POST", input));
export const configureModelDefinition = (id: string, input: Pick<ModelDefinition, "profile" | "timeoutSeconds" | "maxTokens">) => requestController<ModelDefinition>(`/api/v1/models/${encodeURIComponent(id)}/protocol`, json("PUT", input));
export const revalidateModelDefinition = (id: string) => requestController<ModelDefinition>(`/api/v1/models/${encodeURIComponent(id)}/validate`, json("POST"));
export const testModelConnection = (id: string) => requestController<ModelDefinition>(`/api/v1/models/${encodeURIComponent(id)}/test-connection`, json("POST"));
export const deleteModelDefinition = (id: string) => requestController<void>(`/api/v1/models/${encodeURIComponent(id)}`, json("DELETE"));
export const saveModelAssignments = (assignments: ModelAssignments) => requestController<ModelConfigurationRevision>("/api/v1/model-configuration/draft", json("PUT", assignments));
export const validateModelConfiguration = () => requestController<ModelConfigurationRevision>("/api/v1/model-configuration/validate", json("POST"));
export const activateModelConfiguration = (revisionId: string) => requestController<ModelConfigurationView & { distribution: { desiredGeneration: number; distributionStatus: "ready" | "syncing" } }>(`/api/v1/model-configuration/${encodeURIComponent(revisionId)}/activate`, json("POST"));
export const rollbackModelConfiguration = () => requestController<ModelConfigurationView & { distribution: { desiredGeneration: number; distributionStatus: "ready" | "syncing" } }>("/api/v1/model-configuration/rollback", json("POST"));
export const listControllerGuardrails = () => requestController<Collection<Guardrail>>("/api/v1/guardrails");
export const getControllerGuardrail = (id: string) => requestController<GuardrailDetail>(`/api/v1/guardrails/${encodeURIComponent(id)}`);
export const createControllerGuardrail = (input: Pick<Guardrail, "name" | "description" | "draftConfig" | "runtimeProfile">) => requestController<Guardrail>("/api/v1/guardrails", json("POST", input));
export const previewControllerGuardrailPlan = (input: Pick<Guardrail, "name" | "description" | "draftConfig" | "runtimeProfile">) => requestController<GuardrailPlanPreview>("/api/v1/guardrail-plan-previews", json("POST", input));
export const updateControllerGuardrail = (id: string, input: Partial<Pick<Guardrail, "name" | "description" | "draftConfig" | "runtimeProfile">>) => requestController<Guardrail>(`/api/v1/guardrails/${encodeURIComponent(id)}`, json("PATCH", input));
export const publishControllerGuardrail = (id: string) => requestController<{ status: string; version: string }>(`/api/v1/guardrails/${encodeURIComponent(id)}/publish`, json("POST"));
export const rollbackControllerGuardrail = (id: string, version: string) => requestController<GuardrailVersion>(`/api/v1/guardrails/${encodeURIComponent(id)}/rollback/${encodeURIComponent(version)}`, json("POST"));
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
