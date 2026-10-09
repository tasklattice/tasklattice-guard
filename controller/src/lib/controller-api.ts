import type { AuditQuery } from "../../shared/audit-query";
import type { EnforcementAction } from "../../shared/enforcement-action.generated";
import type {
  GuardrailLifecycleState,
  GuardrailVersionState,
  EndpointLifecycleState,
  RunnerStatus,
  ValidationRunState,
} from "../../shared/lifecycle";
import type { CapabilityBindingId, ImplementedGuardrailRailType } from "../../shared/guardrail-catalog";
import type { PlatformStatusSnapshot } from "../../shared/platform-status";
import type { SystemHealthSnapshot } from "../../shared/component-health";
export type { SystemHealthSnapshot } from "../../shared/component-health";
import type { GuardrailVersionDeletionImpact } from "../../shared/guardrail-version-deletion";
export type { GuardrailVersionDeletionImpact } from "../../shared/guardrail-version-deletion";

export type Collection<T> = { items: T[]; count?: number; nextCursor?: string | null };

export type SystemStatus = PlatformStatusSnapshot;

export type ModelProviderKind = "openai" | "qwen" | "deepseek" | "vllm" | "ollama" | "custom-openai-compatible";
export type ModelProfile = "generic-chat" | "tali.qwen3guard.v1" | "tali.llama-guard-3.v1" | "tali.nemotron-content-safety.v1" | "tali.nemotron-safety-guard-v3.v1" | "tali.nemoguard-topic-control.v1" | "tali.openai-compatible-jailbreak.v1" | "tali.nemoguard-jailbreak-detect.v1" | "tali.taxonomy-judge.v1" | "tali.grounding-judge.v1" | "tali.automated-reasoning.v1";
export type { CapabilityBindingId };
export type ModelAssignments = {
  controlPlane: string | null;
  bindings: Record<CapabilityBindingId, string | null>;
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
    scope: "configuration" | "provider" | "model" | "capability";
    status: "passed" | "failed" | "skipped";
    message: string;
    latencyMs?: number;
    evidenceKind?: "model-probe" | "nemo-rail-v1";
  cases?: Array<{ id: string; passed: boolean; inputContent: string; outputContent: string; expectedDecision: string; actualDecision: string; reason: string }>;
  }>;
  contractCoverage: Array<{ contract: string; bindingId: CapabilityBindingId | null; railType: ImplementedGuardrailRailType | null; source: "local" | "model"; modelId: string | null }>;
  policies: Array<{ id: string; name: string; status: "ready" | "blocked" | "unknown"; dependenciesComplete: boolean; missingContracts: string[] }>;
};

export type ModelConfigurationRevision = {
  id: string;
  reviewToken?: string;
  /** Legacy field; current API exposes configuration state, not version history. */
  revision?: number;
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
  draft: ModelConfigurationRevision | null;
  active: ModelConfigurationRevision | null;
  activating: ModelConfigurationRevision | null;
  failed: ModelConfigurationRevision | null;
};

export type GuardrailDraftConfig = {
  allowedTopics: string[];
  restrictedTopics: string[];
  topicControlMode?: "strict" | "permissive";
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
};

export type Guardrail = {
  copyOrigin?: { sourceGuardrailId: string; sourceName: string; sourceVersion: string | null; sourceDraftRevision: number | null; copiedAt: string; contentDigest: string } | null;
  id: string;
  name: string;
  draftConfig: GuardrailDraftConfig;
  runtimeProfile: string;
  status: GuardrailLifecycleState;
  desiredGeneration: number;
  draftRevision: number;
  excludedTestCaseIds: string[];
  loggingLevel: "info" | "debug" | "trace";
  /** Draft revision the most recent publication came from; null before any. */
  publishedSourceDraftRevision: number | null;
  hasUnpublishedChanges?: boolean;
  createdAt: string;
  updatedAt: string;
  latestValidationRun: ValidationRun | null;
  testCaseCount: number;
  excludedTestCaseCount: number;
  /** "imported" Guardrails have no draft; versions arrive in release packages. */
  origin?: "local" | "imported";
  sourceId?: string | null;
};

export type GuardrailVersion = {
  hasSourceSnapshot?: boolean;
  /** Frozen Test Cases in this version; null when published before suites were frozen. */
  testSuiteCount?: number | null;
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
  origin?: "local" | "imported";
  /** Passed test run whose candidate this version publishes; absent on older versions. */
  validationRunId?: string | null;
  /** Read-only description frozen with the version (names of its Policies and Rules). */
  inspection?: { policies: Array<{ policyId: string; policyVersion: string; name: string }> } | null;
  environmentCheck?: EnvironmentCheck | null;
  provenance?: VersionProvenance | null;
};

export type EnvironmentCheck = {
  status: "compatible" | "missing" | "pending";
  checkedAt: string;
  pools: Array<{ poolId: string; runnerId: string; admitted: boolean; unavailable: boolean; reason: string; nemoVersion: string; modelRevisionId: string }>;
};

export type ArtifactRequirements = {
  contentContract: string;
  runtime: { nemoVersion: string; runtimeProfile: string; compilerVersion: string; planCompilerVersion: string };
  actions: Array<{ name: string; version: string }>;
  models: Array<{ type: string; profile: string }>;
  evaluationContracts: Array<{ contract: string; capability: string; phases: string[] }>;
};

export type SourceEvidence = {
  status: "passed";
  testedAt: string;
  completedAt: string | null;
  publishedAt: string;
  metrics: { total?: number; passed?: number; complianceRate?: number } & Record<string, unknown>;
  source: { id: string; name: string };
  validationRunId: string;
};

export type VersionProvenance = {
  sourceId: string;
  sourceKeyId: string;
  contentDigest: string;
  packageId: string;
  importedAt: string;
  importedBy: string | null;
  requirements: ArtifactRequirements;
  uatEvidence: SourceEvidence;
};

export type PackagePreview = {
  packageId: string;
  source: { id: string; name: string };
  keyId: string;
  exportedAt: string;
  guardrail: { id: string; name: string; exists: boolean };
  versions: Array<{
    version: string;
    state: "new" | "existing" | "conflict";
    contentDigest: string;
    evidence: SourceEvidence;
    requirements: ArtifactRequirements;
    environment: EnvironmentCheck | null;
  }>;
  blockers: Array<{ code: string; message: string }>;
};

export type PackageImportResult = { guardrailId: string; imported: string[]; existing: string[] };

export type DeploymentCapabilities = {
  authoringEnabled: boolean;
  packageExport: { available: boolean; sourceId: string | null };
  packageImport: { available: boolean };
};

export type SystemBaseline = { guardrailId: string; version: string | null };

/** One Test Case frozen into a Guardrail version: its input and expected behaviour. */
export type FrozenTestCase = {
  id: string; name: string; origin: string; policyId: string; phase: string; content: string; expectedDecision: string;
  caseType: string; required: boolean; sourcePolicyId: string | null; sourcePolicyVersion: string | null; sourceCaseId: string | null;
  coveredRuleIds: string[]; expectationOverride: { reason: string; expectedDecision: string; sourcePolicyVersion: string } | null;
};
export type VersionTestSuite = { guardrailId: string; version: string; recorded: boolean; digest: string | null; items: FrozenTestCase[]; count: number };

export type ReleasedPolicyUsage = {
  guardrailId: string; guardrailName: string; guardrailVersion: string; origin: "local" | "imported"; sourceId: string | null;
  serving: boolean; enabledRuleIds: string[]; action: string | null; phases: string[];
};
/** One released version: its frozen definition, in the shape the Policy Library lists, and who uses it. */
export type ReleasedPolicyVersion = {
  version: string; contentDigest: string | null; name: string;
  definition: import("./api-types").Policy; usage: ReleasedPolicyUsage[];
};
/** A Policy as released in this environment's Guardrail versions, grouped by Policy ID. */
export type ReleasedPolicy = {
  policyId: string; name: string; source: "built_in" | "custom"; serving: boolean;
  versions: ReleasedPolicyVersion[]; conflictingVersions: string[];
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

export type Endpoint = {
  id: string;
  name: string;
  adapter: string;
  status: EndpointLifecycleState;
  createdAt: string;
  updatedAt: string;
  credential?: string;
  desiredGeneration?: number;
  distributionStatus?: "ready" | "syncing";
};

export type ValidationRun = {
  id: string;
  guardrailId: string;
  guardrailVersion: string;
  sourceDraftRevision: number;
  status: ValidationRunState;
  progress?: import("../../shared/validation-progress").ValidationProgress | null;
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
  activeRouterCount: number;
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
  endpointId: string | null;
  routerId: string | null;
  direction: "incoming" | "outgoing" | "completion";
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

export class ControllerRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly detail?: unknown) {
    super(message);
    this.name = "ControllerRequestError";
  }
}

export async function requestController<T>(path: string, init?: RequestInit): Promise<T> {
  const formData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    ...(!init?.method || init.method === 'GET' ? { signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) } : {}),
    headers: init?.body && !formData ? { "content-type": "application/json", ...init.headers } : init?.headers,
  });
  if (response.status === 204) return undefined as T;
  const rawResponse = response.ok ? undefined : response.clone?.();
  const payload = await response.json().catch(async () => ({ message: await rawResponse?.text().catch(() => "") })) as { error?: { code?: string; message?: string; detail?: unknown }; detail?: unknown; message?: string };
  if (!response.ok) {
    // A forbidden write may mean the user's role changed. Recheck identity,
    // without treating every 403 as a logout or retrying the rejected write.
    if (response.status === 401 || response.status === 403) window.dispatchEvent(new CustomEvent("tasklattice:unauthorized"));
    throw new ControllerRequestError(
      formatApiError(payload.error?.detail ?? payload.detail) ?? payload.error?.message ?? payload.message ?? `Request failed with status ${response.status}.`,
      response.status, payload.error?.code, payload.error?.detail ?? payload.detail,
    );
  }
  return payload as T;
}

function formatApiError(detail: unknown): string | undefined {
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
  return undefined;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const getControllerSystemStatus = async () => {
  const response = await fetch("/api/v1/system/status", { credentials: "same-origin" });
  if (response.status === 200 || response.status === 503) return response.json() as Promise<SystemStatus>;
  throw new Error(`System status failed with status ${response.status}.`);
};
export const getControllerSystemHealth = async (signal?: AbortSignal) => {
  const timeout = AbortSignal.timeout(10_000);
  const snapshot = await requestController<SystemHealthSnapshot>("/api/v1/system/health", {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!snapshot?.components?.controlPlane || !snapshot.components.dataPlane
    || !["healthy", "unhealthy", "unknown"].includes(snapshot.status)
    || !Number.isFinite(Date.parse(snapshot.observedAt))) {
    throw new Error("Component health response is unavailable.");
  }
  return snapshot;
};
export const getModelConfiguration = async () => {
  const view = await requestController<ModelConfigurationView>("/api/v1/model-configuration");
  if (!view.draft?.assignments?.bindings) {
    throw new Error("The Controller is serving an incompatible legacy Model configuration. Deploy the matching Controller backend before using Guardrail Catalog.");
  }
  return view;
};
export type ProviderConnectionDraft = { name: string; kind: ModelProviderKind; baseUrl: string; apiKey: string; skipTlsVerify?: boolean };
export type ProviderModelSelection = { name: string; model: string; profile: ModelProfile; timeoutSeconds: number; maxTokens: number };
export type ProviderRegistrationResult = { provider: ModelProvider; models: ModelDefinition[]; failures: Array<{ model: ProviderModelSelection; message: string }> };
export const discoverProviderDraft = (input: ProviderConnectionDraft) => requestController<Omit<DiscoveredProviderModels, "providerId">>("/api/v1/model-provider-discoveries", json("POST", input));
export const registerProviderModels = (input: { connection: ProviderConnectionDraft; models: ProviderModelSelection[] }) => requestController<ProviderRegistrationResult>("/api/v1/model-provider-registrations", json("POST", input));
export const createModelProvider = (input: { name: string; kind: ModelProviderKind; baseUrl: string; apiKey?: string; skipTlsVerify?: boolean }) => requestController<ModelProvider>("/api/v1/model-providers", json("POST", input));
export const updateModelProviderCredential = (id: string, apiKey: string) => requestController<ModelProvider>(`/api/v1/model-providers/${encodeURIComponent(id)}`, json("PATCH", { apiKey }));
export const updateProviderTls = (id: string, skipTlsVerify: boolean) => requestController<ModelProvider>(`/api/v1/model-providers/${encodeURIComponent(id)}`, json("PATCH", { skipTlsVerify }));
export const revalidateModelProvider = (id: string) => requestController<ModelProvider>(`/api/v1/model-providers/${encodeURIComponent(id)}/connection-tests`, json("POST"));
export const discoverModelProvider = (id: string) => requestController<DiscoveredProviderModels>(`/api/v1/model-providers/${encodeURIComponent(id)}/model-discoveries`, json("POST"));
export const deleteModelProvider = (id: string) => requestController<void>(`/api/v1/model-providers/${encodeURIComponent(id)}`, json("DELETE"));
export const createModelDefinition = (input: { providerId: string; name: string; model: string; profile: ModelProfile; timeoutSeconds: number; maxTokens: number }) => requestController<ModelDefinition>("/api/v1/models", json("POST", input));
export const configureModelDefinition = (id: string, input: Pick<ModelDefinition, "profile" | "timeoutSeconds" | "maxTokens">) => requestController<ModelDefinition>(`/api/v1/models/${encodeURIComponent(id)}/protocol`, json("PUT", input));
export const revalidateModelDefinition = (id: string) => requestController<ModelDefinition>(`/api/v1/models/${encodeURIComponent(id)}/capability-tests`, json("POST"));
export const testModelConnection = (id: string) => requestController<ModelDefinition>(`/api/v1/models/${encodeURIComponent(id)}/connection-tests`, json("POST"));
export const deleteModelDefinition = (id: string) => requestController<void>(`/api/v1/models/${encodeURIComponent(id)}`, json("DELETE"));
export const saveModelAssignments = (assignments: ModelAssignments) => requestController<ModelConfigurationRevision>("/api/v1/model-configuration/draft", json("PUT", assignments));
export const validateModelConfiguration = () => requestController<ModelConfigurationRevision>("/api/v1/model-configuration/draft/validations", json("POST"));
export type ModelAssignmentTarget = "control_plane" | CapabilityBindingId;
export const saveModelAssignment = (target: ModelAssignmentTarget, modelId: string | null, validationId?: string) => requestController<ModelConfigurationRevision>(`/api/v1/model-configuration/draft/assignments/${encodeURIComponent(target)}`, json("PUT", { modelId, validationId }));
export const validateModelAssignment = (target: ModelAssignmentTarget, modelId?: string) => requestController<ModelConfigurationRevision & { validationId?: string }>(`/api/v1/model-configuration/draft/assignments/${encodeURIComponent(target)}/${modelId ? "candidate-validations" : "validations"}`, json("POST", modelId ? { modelId } : undefined));
export const applyModelConfiguration = (selection: import("../../shared/model-activation").PartialModelActivation) => requestController<ModelConfigurationView & { distribution: { desiredGeneration: number; distributionStatus: "ready" | "syncing" } }>("/api/v1/model-configuration/apply", json("POST", selection));
export const listControllerGuardrails = () => requestController<Collection<Guardrail>>("/api/v1/guardrails");
export const getControllerGuardrail = (id: string) => requestController<GuardrailDetail>(`/api/v1/guardrails/${encodeURIComponent(id)}`);
export const createControllerGuardrail = (input: Pick<Guardrail, "name" | "draftConfig" | "runtimeProfile">) => requestController<Guardrail>("/api/v1/guardrails", json("POST", input));
export const previewControllerGuardrailPlan = (input: Pick<Guardrail, "name" | "draftConfig" | "runtimeProfile">) => requestController<GuardrailPlanPreview>("/api/v1/authoring/plan-previews", json("POST", input));
export const updateControllerGuardrail = (id: string, input: Partial<Pick<Guardrail, "name" | "draftConfig" | "runtimeProfile">> & { expectedDraftRevision?: number }) => requestController<Guardrail>(`/api/v1/guardrails/${encodeURIComponent(id)}`, json("PATCH", input));
export const publishControllerGuardrail = (id: string, expectedDraftRevision: number) => requestController<{ status: string; version: string }>(`/api/v1/guardrails/${encodeURIComponent(id)}/publish`, json("POST", { expectedDraftRevision }));
export const getReleasedPolicies = () => requestController<{ items: ReleasedPolicy[] }>("/api/v1/released-policies");
export const getDeploymentCapabilities = () => requestController<DeploymentCapabilities>("/api/v1/deployment/capabilities");
export const uploadGuardrailPackage = (file: File) => {
  const body = new FormData();
  body.append("package", file);
  return requestController<PackagePreview>("/api/v1/guardrail-packages", { method: "POST", body });
};
export const importGuardrailPackage = (packageId: string, versions?: string[]) => requestController<PackageImportResult>(
  `/api/v1/guardrail-packages/${encodeURIComponent(packageId)}/imports`, { method: "POST", body: JSON.stringify(versions ? { versions } : {}) });
export const checkGuardrailVersionEnvironment = (id: string, version: string) => requestController<EnvironmentCheck>(
  `/api/v1/guardrails/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/environment-check`, { method: "POST" });
export const getSystemBaseline = () => requestController<SystemBaseline>("/api/v1/system/baseline");
export const getGuardrailVersionTestSuite = (guardrailId: string, version: string) => requestController<VersionTestSuite>(`/api/v1/guardrails/${encodeURIComponent(guardrailId)}/versions/${encodeURIComponent(version)}/test-suite`);
export const setSystemBaseline = (version: string, reason: string) => requestController<SystemBaseline>("/api/v1/system/baseline", { method: "PUT", body: JSON.stringify({ version, reason }) });

/** Download a signed release package; JSON errors become ControllerRequestError. */
export async function downloadGuardrailPackage(id: string, versions: string[]): Promise<string> {
  const response = await fetch(`/api/v1/guardrails/${encodeURIComponent(id)}/package?versions=${versions.map(encodeURIComponent).join(",")}`, { credentials: "same-origin" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string; detail?: unknown } };
    throw new ControllerRequestError(payload.error?.message ?? `Request failed with status ${response.status}.`, response.status, payload.error?.code, payload.error?.detail);
  }
  const filename = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? `${id}.guardrail.zip`;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Allow the browser to begin the download before releasing its Blob URL.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return filename;
}
export const getControllerGuardrailDeletionImpact = (id: string) => requestController<DeletionImpact>(`/api/v1/guardrails/${encodeURIComponent(id)}/deletion-impact`);
export const deleteControllerGuardrail = (id: string, input: { reason: string; confirmRecentTraffic: boolean; confirmationName?: string | undefined }) => requestController<void>(`/api/v1/guardrails/${encodeURIComponent(id)}`, json("DELETE", input));

export const listControllerEndpoints = () => requestController<Collection<Endpoint>>("/api/v1/endpoints");
export const createControllerEndpoint = (input: { name: string; adapter: string }) => requestController<Endpoint>("/api/v1/endpoints", json("POST", input));
export const getControllerEndpointDeletionImpact = (id: string) => requestController<DeletionImpact>(`/api/v1/endpoints/${encodeURIComponent(id)}/deletion-impact`);
export const deleteControllerEndpoint = (id: string, input: { reason: string; confirmRecentTraffic: boolean; confirmationName?: string | undefined }) => requestController<void>(`/api/v1/endpoints/${encodeURIComponent(id)}`, json("DELETE", input));

export { listTrafficRouters as listControllerRouters } from "./traffic-routing-api";
export const listRunnerPools = (signal?: AbortSignal) => requestController<Collection<RunnerPool>>("/api/v1/runner-pools", {
  signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
});
export const updateRunnerPool = (id: string, input: Pick<RunnerPool, "desiredReplicas" | "safeRpsPerRunner" | "maxConcurrencyPerRunner">) => requestController<RunnerPool>(`/api/v1/runner-pools/${encodeURIComponent(id)}`, json("PATCH", input));
export const removeRunnerInstance = (runnerId: string, options?: { force: true; bootId: string }) => {
  const query = options ? `?${new URLSearchParams({ force: "true", bootId: options.bootId })}` : "";
  return requestController<void>(`/api/v1/runner-instances/${encodeURIComponent(runnerId)}${query}`, json("DELETE"));
};
export const listRuntimeEvents = (limit = 100, filters: { guardrailId?: string; routerId?: string; routeId?: string; targetId?: string; routerRevision?: number; endpointId?: string; until?: string; since?: string; before?: string; cursor?: string; requestId?: string; direction?: string; outcome?: string; captured?: string; findingsOnly?: string; severity?: string } = {}, signal?: AbortSignal) => {
  const query = new URLSearchParams({ limit: String(Math.min(500, Math.max(1, limit))) });
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, String(value));
  return requestController<Collection<RuntimeEvent>>(`/api/v1/telemetry/events?${query.toString()}`, signal ? { signal } : undefined);
};
export const getRuntimeEvent = (id: string, signal?: AbortSignal, includeContent = false) => requestController<RuntimeEvent>(`/api/v1/telemetry/events/${encodeURIComponent(id)}${includeContent ? "?includeContent=true" : ""}`, signal ? { signal } : undefined);
export type AuditEventPage = { items: AuditEvent[]; total: number; page: number; limit: number; before: string; facets: { kinds: string[]; resourceTypes: string[] } };
export const listAuditEvents = (query: Partial<AuditQuery> = {}, signal?: AbortSignal) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") search.set(key, String(value));
  return requestController<AuditEventPage>(`/api/v1/audit-events?${search}`, signal ? { signal } : undefined);
};

export const getGuardrailVersionDeletionImpact = (id: string, version: string) => requestController<GuardrailVersionDeletionImpact>(`/api/v1/guardrails/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/deletion-impact`);
export const deleteControllerGuardrailVersion = (id: string, version: string) => requestController<void>(`/api/v1/guardrails/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`, { method: "DELETE" });

export type SystemVersion = {
  controlPlane: import("../../shared/software-version").SoftwareVersion;
  dataPlane: Array<{ runnerId: string; poolId: string; status: RunnerStatus; lastHeartbeatAt: string | null; software: import("../../shared/software-version").SoftwareVersion }>;
};
export const getSystemVersion = () => requestController<SystemVersion>("/api/v1/system/version");
