import * as controllerApi from "@/lib/controller-api";
import {
  arrayOfRecords,
  arrayOfStrings,
  enumValue,
  numberValue,
  stringValue,
} from "@/lib/controller-api-mappers";
import type {
  ActionDefinition,
  Collection,
  ComplianceDocumentAnalysis,
  DeleteConfirmation,
  Guardrail,
  GuardrailCompilePreview,
  GuardrailDeletionImpact,
  GuardrailLoggingSettings,
  GuardrailPolicyBinding,
  GuardrailPurposeDetails,
  GuardrailVersion,
  GuardrailVersionDetail,
  IntentAnalysis,
  IntentAnalysisStatus,
  LoggingLevel,
  OutputDelivery,
  PlaygroundDraftPreview,
  PlaygroundInteraction,
  PlaygroundModel,
  PlaygroundTarget,
  Policy,
  PolicyDraftValidationRun,
  PolicyValidation,
  ProgrammablePolicyDraft,
  ProgrammablePolicyVersion,
  SafetyLevel,
  TestCase,
  ValidationRun,
} from "@/lib/api-types";

const DEFAULT_GUARDRAIL_ID = "guardrail-default";

type CurrentPolicyBinding = controllerApi.GuardrailDraftConfig["policyBindings"][number];
type CurrentTestCase = {
  id: string;
  guardrailId: string;
  name: string;
  policyId: string;
  phase: "input" | "output";
  content: string;
  expectedDecision: "allow" | "block" | "transform" | "intervene";
  origin: "generated" | "custom";
  updatedAt: string;
  trustedInstruction: string;
  targetSource: TestCase["target_source"];
  query: string;
  groundingSources: string[];
  expectedReasoningResult: TestCase["expected_reasoning_result"];
  sourcePolicyId: string | null;
  sourcePolicyVersion: string | null;
  sourceCaseId: string | null;
  coveredRuleIds: string[];
  caseType: string;
  required: boolean;
  excluded: boolean;
};

const emptyCollection = <T>(): Collection<T> => ({ items: [], count: 0 });

function toCurrentBinding(binding: GuardrailPolicyBinding): CurrentPolicyBinding {
  return {
    policyId: binding.policy_id,
    policyVersion: binding.policy_version,
    action: binding.action ?? null,
    parameterValues: binding.parameter_values,
    enabledRuleIds: binding.enabled_rule_ids,
    ruleActions: binding.rule_actions,
    enabledRails: binding.enabled_rails,
    reasoningPolicy: binding.reasoning_policy ? {
      policyId: binding.reasoning_policy.policy_id,
      policyVersion: binding.reasoning_policy.policy_version,
      confidenceThreshold: binding.reasoning_policy.confidence_threshold,
    } : null,
  };
}

function fromCurrentBinding(binding: CurrentPolicyBinding): GuardrailPolicyBinding {
  return {
    policy_id: binding.policyId,
    policy_version: binding.policyVersion,
    action: binding.action,
    parameter_values: binding.parameterValues,
    enabled_rule_ids: binding.enabledRuleIds,
    rule_actions: binding.ruleActions,
    enabled_rails: binding.enabledRails,
    reasoning_policy: binding.reasoningPolicy ? {
      policy_id: binding.reasoningPolicy.policyId,
      policy_version: binding.reasoningPolicy.policyVersion,
      confidence_threshold: binding.reasoningPolicy.confidenceThreshold,
    } : null,
  };
}

function mapGuardrail(
  value: controllerApi.Guardrail,
  deploymentCount: number,
  publishedVersionCount?: number,
): Guardrail {
  const isDefault = value.id === DEFAULT_GUARDRAIL_ID;
  const latestValidation = value.latestValidationRun ? mapValidationRun(value.latestValidationRun) : null;
  const testedCurrent = Boolean(latestValidation && latestValidation.source_draft_version === value.draftRevision && latestValidation.status === "passed");
  const published = value.status === "active" && value.activeVersion !== null;
  const publishedCurrent = published && value.activeSourceDraftRevision === value.draftRevision;
  return {
    id: value.id,
    name: value.name,
    purpose: value.description,
    purpose_details: {
      audience: value.draftConfig.purposeDetails?.audience ?? "",
      tasks: value.draftConfig.purposeDetails?.tasks ?? "",
      protect: value.draftConfig.purposeDetails?.protect ?? "",
      out_of_scope: value.draftConfig.purposeDetails?.outOfScope ?? "",
    },
    custom_content_rules: value.draftConfig.customContentRules ?? [],
    allowed_topics: value.draftConfig.allowedTopics,
    restricted_topics: value.draftConfig.restrictedTopics,
    policy_bindings: value.draftConfig.policyBindings.map(fromCurrentBinding),
    safety_level: value.draftConfig.safetyLevel,
    output_delivery: value.draftConfig.outputDelivery,
    updated_at: value.updatedAt,
    status: publishedCurrent ? (deploymentCount > 0 ? "protected" : "ready") : "needs_validation",
    latest_validation_run: latestValidation,
    deployment_count: deploymentCount,
    test_case_count: value.testCaseCount,
    excluded_test_case_count: value.excludedTestCaseCount,
    excluded_test_case_ids: value.excludedTestCaseIds,
    draft_revision: value.draftRevision,
    tested_current: testedCurrent,
    published_current: publishedCurrent,
    published_version_count: publishedVersionCount,
    is_default: isDefault,
    system_managed: isDefault,
    local_only: isDefault,
    coverage: [],
  };
}

function deploymentCounts(values: controllerApi.Deployment[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const deployment of values) {
    if (deployment.enabled) result.set(deployment.guardrailId, (result.get(deployment.guardrailId) ?? 0) + 1);
  }
  return result;
}

export async function getGuardrails(): Promise<Collection<Guardrail>> {
  const [guardrails, deployments] = await Promise.all([
    controllerApi.listControllerGuardrails(),
    controllerApi.listControllerDeployments(),
  ]);
  const counts = deploymentCounts(deployments.items);
  const items = guardrails.items.map((item) => mapGuardrail(item, counts.get(item.id) ?? 0));
  return { items, count: items.length };
}

export async function getGuardrail(id: string): Promise<Guardrail> {
  const [guardrail, deployments] = await Promise.all([
    controllerApi.getControllerGuardrail(id),
    controllerApi.listControllerDeployments(),
  ]);
  const count = deployments.items.filter((item) => item.enabled && item.guardrailId === id).length;
  return mapGuardrail(guardrail, count, guardrail.versions.length);
}

export async function createGuardrail(input: {
  name: string;
  purpose?: string;
  purpose_details?: GuardrailPurposeDetails;
  custom_content_rules?: Guardrail["custom_content_rules"];
  allowed_topics?: string[];
  restricted_topics?: string[];
  policy_bindings: GuardrailPolicyBinding[];
  safety_level?: SafetyLevel;
  output_delivery?: OutputDelivery;
}): Promise<Guardrail> {
  const created = await controllerApi.createControllerGuardrail({
    name: input.name,
    description: input.purpose ?? "",
    draftConfig: {
      purposeDetails: {
        audience: input.purpose_details?.audience ?? "",
        tasks: input.purpose_details?.tasks ?? "",
        protect: input.purpose_details?.protect ?? "",
        outOfScope: input.purpose_details?.out_of_scope ?? "",
      },
      customContentRules: input.custom_content_rules ?? [],
      allowedTopics: input.allowed_topics ?? [],
      restrictedTopics: input.restricted_topics ?? [],
      policyBindings: input.policy_bindings.map(toCurrentBinding),
      safetyLevel: input.safety_level ?? "balanced",
      outputDelivery: input.output_delivery ?? "window_buffered",
    },
    runtimeProfile: "auto",
  });
  return mapGuardrail(created, 0, 0);
}

export const updateGuardrail = (
  id: string,
  input: Partial<Pick<Guardrail, "name" | "purpose" | "purpose_details" | "custom_content_rules" | "allowed_topics" | "restricted_topics" | "policy_bindings" | "safety_level" | "output_delivery">>,
) => updateGuardrailDraft(id, input);

async function updateGuardrailDraft(
  id: string,
  input: Partial<Pick<Guardrail, "name" | "purpose" | "purpose_details" | "custom_content_rules" | "allowed_topics" | "restricted_topics" | "policy_bindings" | "safety_level" | "output_delivery">>,
): Promise<Guardrail> {
  const current = await controllerApi.getControllerGuardrail(id);
  const updated = await controllerApi.updateControllerGuardrail(id, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.purpose !== undefined ? { description: input.purpose } : {}),
    draftConfig: {
      purposeDetails: {
        audience: input.purpose_details?.audience ?? current.draftConfig.purposeDetails?.audience ?? "",
        tasks: input.purpose_details?.tasks ?? current.draftConfig.purposeDetails?.tasks ?? "",
        protect: input.purpose_details?.protect ?? current.draftConfig.purposeDetails?.protect ?? "",
        outOfScope: input.purpose_details?.out_of_scope ?? current.draftConfig.purposeDetails?.outOfScope ?? "",
      },
      customContentRules: input.custom_content_rules ?? current.draftConfig.customContentRules ?? [],
      allowedTopics: input.allowed_topics ?? current.draftConfig.allowedTopics,
      restrictedTopics: input.restricted_topics ?? current.draftConfig.restrictedTopics,
      policyBindings: (input.policy_bindings ?? current.draftConfig.policyBindings.map(fromCurrentBinding)).map(toCurrentBinding),
      safetyLevel: input.safety_level ?? current.draftConfig.safetyLevel,
      outputDelivery: input.output_delivery ?? current.draftConfig.outputDelivery,
    },
  });
  return mapGuardrail(updated, 0, current.versions.length);
}

export async function getGuardrailDeletionImpact(id: string): Promise<GuardrailDeletionImpact> {
  const [impact, guardrail] = await Promise.all([
    controllerApi.getControllerGuardrailDeletionImpact(id),
    controllerApi.getControllerGuardrail(id),
  ]);
  return {
    guardrail_id: impact.resourceId,
    guardrail_name: guardrail.name,
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

export const deleteGuardrail = (id: string, confirmation: DeleteConfirmation) => controllerApi.deleteControllerGuardrail(id, {
  reason: confirmation.reason,
  confirmRecentTraffic: confirmation.confirm_recent_traffic,
  ...(confirmation.confirmation_name ? { confirmationName: confirmation.confirmation_name } : {}),
});

function mapVersion(value: controllerApi.GuardrailVersion, guardrail: controllerApi.Guardrail): GuardrailVersion {
  const compiler = value.artifact?.compilerVersion ?? stringValue(value.plan.compiler_version) ?? "tasklattice-controller-plan-v1";
  return {
    guardrail_id: value.guardrailId,
    version: value.version,
    source_draft_version: value.sourceDraftRevision,
    compiler_version: compiler,
    plan_checksum: value.artifact?.checksum ?? "",
    created_at: value.createdAt,
    active: guardrail.activeVersion === value.version,
    runtime_engine: runtimeEngine(value.runtimeProfile),
    config_checksum: value.artifact?.checksum ?? "",
    execution_mode: "nemo_only",
    compile_status: value.status,
    failure_reason: value.failureReason,
  };
}

function mapVersionDetail(value: controllerApi.GuardrailVersion, guardrail: controllerApi.Guardrail): GuardrailVersionDetail {
  const base = mapVersion(value, guardrail);
  const steps = arrayOfRecords(value.plan.steps);
  const modules = arrayOfRecords(value.plan.modules);
  const artifactBindings = arrayOfRecords(value.artifact?.actionBindings);
  const dependencies = dependencyRecords(value.artifact?.dependencyManifest);
  const actions = artifactBindings.length ? artifactBindings.map((binding) => ({
    name: stringValue(binding.action_name) ?? stringValue(binding.name) ?? stringValue(binding.id) ?? "runtime-action",
    version: stringValue(binding.action_version) ?? stringValue(binding.version),
    flow: stringValue(binding.flow_name) ?? stringValue(binding.flow),
    phases: arrayOfStrings(binding.phases).filter((phase): phase is "input" | "output" => phase === "input" || phase === "output"),
    timeout_ms: numberValue(binding.timeout_ms) ?? 0,
    failure_mode: stringValue(binding.failure_mode) ?? "fail_closed",
  })) : steps.map((step) => ({
    name: stringValue(step.risk) ?? "controller-plan-step",
    version: null,
    flow: stringValue(step.id),
    phases: arrayOfStrings(step.phases).filter((phase): phase is "input" | "output" => phase === "input" || phase === "output"),
    timeout_ms: moduleTimeoutForStep(step, modules),
    failure_mode: "fail_closed",
  }));
  return {
    ...base,
    safety_level: enumValue(value.plan.safety_level, ["balanced", "strict"]) ?? guardrail.draftConfig.safetyLevel,
    output_delivery: enumValue(value.plan.output_delivery, ["interruptible", "window_buffered", "full_buffered"]) ?? guardrail.draftConfig.outputDelivery,
    runtime_profile: value.runtimeProfile,
    colang_version: colangVersion(value.runtimeProfile),
    rails: steps.flatMap((step) => arrayOfStrings(step.phases).map((phase) => ({
      rail_type: phase === "output" ? "output" as const : "input" as const,
      flow: stringValue(step.id) ?? stringValue(step.risk) ?? "controller-plan-step",
    }))),
    actions,
    models: dependencies.filter((item) => item.kind === "model").map((item) => item.name),
    features: dependencies.filter((item) => item.kind === "feature").map((item) => item.name),
    dependencies,
    estimated_critical_path_ms: Math.max(0, ...modules.map((item) => numberValue(item.timeout_ms) ?? 0)),
    policy_bindings: guardrail.draftConfig.policyBindings.map((currentBinding) => {
      const binding = fromCurrentBinding(currentBinding);
      return {
        policy_id: binding.policy_id,
        policy_version: binding.policy_version,
        action: binding.action ?? null,
        enabled_rule_ids: binding.enabled_rule_ids,
        enabled_rails: binding.enabled_rails,
      };
    }),
    artifacts: value.artifact ? [
      { path: "config/config.yml", language: "yaml", content: value.artifact.configYaml },
      ...(value.artifact.colangContent ? [{ path: "config/rails.co", language: "colang", content: value.artifact.colangContent }] : []),
      { path: "artifact/plan.json", language: "json", content: JSON.stringify(value.artifact.plan, null, 2) },
      { path: "artifact/prompts.json", language: "json", content: JSON.stringify(value.artifact.prompts, null, 2) },
      { path: "artifact/actions.json", language: "json", content: JSON.stringify(value.artifact.actionBindings, null, 2) },
      { path: "artifact/dependencies.json", language: "json", content: JSON.stringify(value.artifact.dependencyManifest, null, 2) },
    ] : [],
  };
}

function dependencyRecords(value: unknown): Array<{ kind: string; name: string; version: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (Array.isArray(item) && item.length >= 3 && item.slice(0, 3).every((part) => typeof part === "string")) {
      return [{ kind: item[0] as string, name: item[1] as string, version: item[2] as string }];
    }
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const kind = stringValue(record.kind);
      const name = stringValue(record.name);
      const version = stringValue(record.version);
      return kind && name && version ? [{ kind, name, version }] : [];
    }
    return [];
  });
}

export async function getGuardrailVersions(guardrailId: string): Promise<Collection<GuardrailVersion>> {
  const guardrail = await controllerApi.getControllerGuardrail(guardrailId);
  const items = guardrail.versions.map((item) => mapVersion(item, guardrail));
  return { items, count: items.length };
}

export async function getGuardrailVersion(guardrailId: string, version: number): Promise<GuardrailVersionDetail> {
  const guardrail = await controllerApi.getControllerGuardrail(guardrailId);
  const found = guardrail.versions.find((item) => item.version === version);
  if (!found) throw new Error(`Guardrail version ${version} was not found.`);
  return mapVersionDetail(found, guardrail);
}

export async function publishGuardrail(guardrailId: string): Promise<GuardrailVersion> {
  const result = await controllerApi.publishControllerGuardrail(guardrailId);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const guardrail = await controllerApi.getControllerGuardrail(guardrailId);
    const version = guardrail.versions.find((item) => item.version === result.version);
    if (version?.status === "ready") return mapVersion(version, guardrail);
    if (version?.status === "failed") throw new Error(version.failureReason || `Guardrail version ${result.version} failed to compile.`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Guardrail version ${result.version} is still compiling. Check Controller activity for progress.`);
}

export const rollbackGuardrail = (guardrailId: string, version: number) =>
  controllerApi.rollbackControllerGuardrail(guardrailId, version).then(async (item) => {
    const guardrail = await controllerApi.getControllerGuardrail(guardrailId);
    return mapVersion(item, guardrail);
  });

export function previewGuardrailCandidate(input: {
  name: string;
  purpose: string;
  purpose_details?: GuardrailPurposeDetails;
  custom_content_rules?: Guardrail["custom_content_rules"];
  allowed_topics?: string[];
  restricted_topics?: string[];
  policy_bindings: GuardrailPolicyBinding[];
  safety_level?: SafetyLevel;
  output_delivery?: OutputDelivery;
}): Promise<GuardrailCompilePreview> {
  return controllerApi.previewControllerGuardrailPlan({
    name: input.name,
    description: input.purpose,
    draftConfig: {
      purposeDetails: {
        audience: input.purpose_details?.audience ?? "",
        tasks: input.purpose_details?.tasks ?? "",
        protect: input.purpose_details?.protect ?? "",
        outOfScope: input.purpose_details?.out_of_scope ?? "",
      },
      customContentRules: input.custom_content_rules ?? [],
      allowedTopics: input.allowed_topics ?? [],
      restrictedTopics: input.restricted_topics ?? [],
      policyBindings: input.policy_bindings.map(toCurrentBinding),
      safetyLevel: input.safety_level ?? "balanced",
      outputDelivery: input.output_delivery ?? "full_buffered",
    },
    runtimeProfile: "auto",
  }).then((value) => ({
    ...value,
    rails: value.rails.flatMap((rail) => ["input", "output", "retrieval", "dialog", "execution"].includes(rail.rail_type)
      ? [{ ...rail, rail_type: rail.rail_type as GuardrailCompilePreview["rails"][number]["rail_type"] }]
      : []),
  }));
}

export async function getGuardrailCompilePreview(id: string): Promise<GuardrailCompilePreview> {
  const guardrail = await controllerApi.getControllerGuardrail(id);
  return previewGuardrailCandidate({
    name: guardrail.name,
    purpose: guardrail.description,
    purpose_details: {
      audience: guardrail.draftConfig.purposeDetails?.audience ?? "",
      tasks: guardrail.draftConfig.purposeDetails?.tasks ?? "",
      protect: guardrail.draftConfig.purposeDetails?.protect ?? "",
      out_of_scope: guardrail.draftConfig.purposeDetails?.outOfScope ?? "",
    },
    custom_content_rules: guardrail.draftConfig.customContentRules ?? [],
    policy_bindings: guardrail.draftConfig.policyBindings.map(fromCurrentBinding),
    safety_level: guardrail.draftConfig.safetyLevel,
    output_delivery: guardrail.draftConfig.outputDelivery,
  });
}

export const getPolicies = () => controllerApi.requestController<Collection<Policy>>("/api/v1/policies");
export const getPolicy = (id: string) => controllerApi.requestController<Policy>(`/api/v1/policies/${encodeURIComponent(id)}`);
export const getActionCatalog = () => controllerApi.requestController<Collection<ActionDefinition>>("/api/v1/actions");

export const createProgrammablePolicy = (input: { name: string; description: string; owner: string; draft: ProgrammablePolicyDraft }) => controllerApi.requestController<Policy>("/api/v1/policies", {
  method: "POST", body: JSON.stringify(input),
});
export const updateProgrammablePolicy = (id: string, input: { name?: string; description?: string; owner?: string; draft?: ProgrammablePolicyDraft }) => controllerApi.requestController<Policy>(`/api/v1/policies/${encodeURIComponent(id)}`, {
  method: "PATCH", body: JSON.stringify(input),
});
export const deleteProgrammablePolicy = (id: string) => controllerApi.requestController<void>(`/api/v1/policies/${encodeURIComponent(id)}`, { method: "DELETE" });
export const validateProgrammablePolicy = (id: string) => controllerApi.requestController<PolicyValidation>(`/api/v1/policies/${encodeURIComponent(id)}/validate`, { method: "POST" });
export const getLatestProgrammablePolicyValidation = (id: string) => controllerApi.requestController<PolicyDraftValidationRun>(`/api/v1/policies/${encodeURIComponent(id)}/validation-runs/latest`);
export async function runProgrammablePolicyValidation(id: string): Promise<PolicyDraftValidationRun> {
  const initial = await controllerApi.requestController<PolicyDraftValidationRun>(`/api/v1/policies/${encodeURIComponent(id)}/validation-runs`, { method: "POST" });
  const deadline = Date.now() + 5 * 60_000;
  let current = initial;
  while ((current.status === "queued" || current.status === "running") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    current = await getLatestProgrammablePolicyValidation(id);
  }
  if (current.status === "queued" || current.status === "running") throw new Error("Policy Validation timed out while waiting for GuardRails 0.");
  return current;
}
export const publishProgrammablePolicy = (id: string) => controllerApi.requestController<ProgrammablePolicyVersion>(`/api/v1/policies/${encodeURIComponent(id)}/publish`, { method: "POST" });

export const getIntentAnalysisStatus = () => controllerApi.requestController<IntentAnalysisStatus>("/api/v1/intent-analysis-status");
export const analyzeGuardrailIntent = (input: { purpose: string; language: "en" | "zh-CN" }) => controllerApi.requestController<IntentAnalysis>("/api/v1/intent-analyses", {
  method: "POST",
  body: JSON.stringify(input),
});
export const analyzeComplianceDocuments = (files: File[], language: "en" | "zh-CN") => {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  form.append("language", language);
  return controllerApi.requestController<ComplianceDocumentAnalysis>("/api/v1/compliance-document-analyses", { method: "POST", body: form });
};

function runtimeEngine(profile: string): string {
  if (profile === "iorails_native") return "iorails";
  return "llmrails";
}

function colangVersion(profile: string): string {
  if (profile === "llmrails_colang1_standard") return "1.0";
  if (profile === "llmrails_colang2_programmable") return "2.x";
  if (profile === "iorails_native") return "n/a";
  return "auto";
}

function moduleTimeoutForStep(step: Record<string, unknown>, modules: Record<string, unknown>[]): number {
  const stepId = stringValue(step.id);
  if (!stepId) return 0;
  return modules.find((item) => arrayOfStrings(item.step_ids).includes(stepId))
    ? numberValue(modules.find((item) => arrayOfStrings(item.step_ids).includes(stepId))?.timeout_ms) ?? 0
    : 0;
}

export const getGuardrailLoggingSettings = (id: string) => controllerApi.requestController<CurrentLoggingSettings>(`/api/v1/guardrails/${encodeURIComponent(id)}/logging`).then(mapLogging);
export const updateGuardrailLoggingSettings = (id: string, level: LoggingLevel, acknowledgeCost = false) => controllerApi.requestController<CurrentLoggingSettings>(`/api/v1/guardrails/${encodeURIComponent(id)}/logging`, { method: "PATCH", body: JSON.stringify({ level, acknowledgeCost }) }).then(mapLogging);

export const createValidationRun = (guardrailId: string) => controllerApi.requestController<controllerApi.ValidationRun>("/api/v1/validation-runs", { method: "POST", body: JSON.stringify({ guardrailId }) }).then(waitForValidation);
export async function getValidationRuns(guardrailId?: string): Promise<Collection<ValidationRun>> {
  const suffix = guardrailId ? `?guardrailId=${encodeURIComponent(guardrailId)}` : "";
  const response = await controllerApi.requestController<{ items: controllerApi.ValidationRun[]; count: number }>(`/api/v1/validation-runs${suffix}`);
  return { items: response.items.map(mapValidationRun), count: response.count };
}
export const getValidationRun = (runId: string) => controllerApi.requestController<controllerApi.ValidationRun>(`/api/v1/validation-runs/${encodeURIComponent(runId)}`).then(mapValidationRun);
export const getPlaygroundModels = () => controllerApi.requestController<Collection<PlaygroundModel>>("/api/v1/playground/models");
export const preparePlaygroundDraftPreview = (guardrailId: string) =>
  controllerApi.requestController<PlaygroundDraftPreview>(`/api/v1/playground/draft-previews/${encodeURIComponent(guardrailId)}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
export const createPlaygroundInteraction = (
  guardrailId: string,
  input: {
    target: PlaygroundTarget;
    model_id: string;
    message: string;
    history?: { role: "user" | "assistant"; content: string }[];
  },
) => controllerApi.requestController<PlaygroundInteraction>(input.target.kind === "draft"
  ? `/api/v1/playground/draft-interactions/${encodeURIComponent(guardrailId)}`
  : `/api/v1/playground/interactions/${encodeURIComponent(guardrailId)}`, {
  method: "POST",
  body: JSON.stringify({
    model_id: input.model_id,
    message: input.message,
    history: input.history,
    ...(input.target.kind === "draft"
      ? { preview_id: input.target.preview_id }
      : { guardrail_version: input.target.version }),
  }),
});
export async function getTestCases(guardrailId: string): Promise<Collection<TestCase>> {
  const response = await controllerApi.requestController<{ items: CurrentTestCase[]; count: number }>(`/api/v1/test-cases?guardrailId=${encodeURIComponent(guardrailId)}`);
  return { items: response.items.map(mapTestCase), count: response.count };
}
export const createTestCase = (
  guardrailId: string,
  input: Pick<TestCase, "name" | "policy_id" | "phase" | "content" | "expected_decision" | "trusted_instruction" | "target_source" | "query" | "grounding_sources" | "expected_reasoning_result">,
) => controllerApi.requestController<CurrentTestCase>("/api/v1/test-cases", { method: "POST", body: JSON.stringify({
  guardrailId,
  name: input.name,
  policyId: input.policy_id,
  phase: input.phase,
  content: input.content,
  expectedDecision: input.expected_decision,
  trustedInstruction: input.trusted_instruction,
  targetSource: input.target_source,
  query: input.query,
  groundingSources: input.grounding_sources,
  expectedReasoningResult: input.expected_reasoning_result,
}) }).then(mapTestCase);
export const deleteTestCase = (caseId: string) => controllerApi.requestController<void>(`/api/v1/test-cases/${encodeURIComponent(caseId)}`, { method: "DELETE" });
export const excludeGuardrailTestCase = (guardrailId: string, caseId: string) => controllerApi.requestController<TestCase>(
  `/api/v1/guardrails/${encodeURIComponent(guardrailId)}/validation-scope`,
  { method: "PATCH", body: JSON.stringify({ caseId, excluded: true }) },
);
export const restoreGuardrailTestCase = (guardrailId: string, caseId: string) => controllerApi.requestController<TestCase>(
  `/api/v1/guardrails/${encodeURIComponent(guardrailId)}/validation-scope`,
  { method: "PATCH", body: JSON.stringify({ caseId, excluded: false }) },
);

type CurrentLoggingSettings = { id: string; level: LoggingLevel; updatedAt?: string; retentionDays?: number; contentCaptureEnabled?: boolean };

function mapLogging(item: CurrentLoggingSettings): GuardrailLoggingSettings {
  return {
    guardrail_id: item.id,
    level: item.level,
    updated_at: item.updatedAt ?? new Date().toISOString(),
    updated_by: null,
    retention_days: item.retentionDays ?? 30,
    content_capture_enabled: item.contentCaptureEnabled ?? false,
  };
}

function mapValidationRun(value: controllerApi.ValidationRun): ValidationRun {
  return {
    id: value.id,
    guardrail_id: value.guardrailId,
    guardrail_version: value.guardrailVersion,
    source_draft_version: value.sourceDraftRevision,
    status: value.status === "passed" ? "passed" : value.status === "failed" ? "failed" : "incomplete",
    metrics: {
      total: value.metrics.total,
      passed: value.metrics.passed,
      compliance_rate: value.metrics.complianceRate,
      false_positive_rate: value.metrics.falsePositiveRate,
      false_negative_rate: value.metrics.falseNegativeRate,
      deep_escalation_rate: value.metrics.deepEscalationRate,
      p95_latency_ms: value.metrics.p95LatencyMs,
    },
    results: value.results.map(mapValidationResult),
    excluded_case_ids: value.excludedCaseIds,
    created_at: value.createdAt,
  };
}

function mapValidationResult(value: Record<string, unknown>): ValidationRun["results"][number] {
  const phase = stringValue(value.phase) === "output" ? "output" : "input";
  return {
    case_id: stringValue(value.caseId) ?? "",
    name: stringValue(value.name) ?? "",
    policy_id: stringValue(value.policyId) ?? "",
    expected_decision: stringValue(value.expectedDecision) ?? "",
    actual_decision: stringValue(value.actualDecision) ?? "error",
    passed: Boolean(value.passed),
    stage_reached: stringValue(value.stageReached) ?? "none",
    latency_ms: numberValue(value.latencyMs) ?? 0,
    reason: stringValue(value.reason) ?? "",
    phase,
    input_content: stringValue(value.inputContent) ?? "",
    action: stringValue(value.action) ?? "pass",
    output_content: stringValue(value.outputContent) ?? "",
    findings: arrayOfRecords(value.findings) as ValidationRun["results"][number]["findings"],
    trace: arrayOfRecords(value.trace) as ValidationRun["results"][number]["trace"],
    trusted_instruction: stringValue(value.trustedInstruction) ?? "",
    target_source: (stringValue(value.targetSource) ?? (phase === "output" ? "model_output" : "user_input")) as TestCase["target_source"],
    query: stringValue(value.query) ?? "",
    grounding_sources: arrayOfStrings(value.groundingSources),
    expected_reasoning_result: stringValue(value.expectedReasoningResult) as ValidationRun["results"][number]["expected_reasoning_result"],
    actual_reasoning_result: stringValue(value.actualReasoningResult) as ValidationRun["results"][number]["actual_reasoning_result"],
    case_type: stringValue(value.caseType) ?? "scenario",
    required: value.required !== false,
    expected_failure: stringValue(value.expectedFailure),
    actual_failure: stringValue(value.actualFailure),
    concurrency_group: stringValue(value.concurrencyGroup),
    source_policy_id: stringValue(value.sourcePolicyId),
    source_policy_version: stringValue(value.sourcePolicyVersion),
    source_case_id: stringValue(value.sourceCaseId),
    covered_rule_ids: arrayOfStrings(value.coveredRuleIds),
    matched_rule_ids: arrayOfStrings(value.matchedRuleIds),
  };
}

async function waitForValidation(initial: controllerApi.ValidationRun): Promise<ValidationRun> {
  let current = initial;
  const deadline = Date.now() + 5 * 60_000;
  while ((current.status === "queued" || current.status === "running") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    current = await controllerApi.requestController<controllerApi.ValidationRun>(`/api/v1/validation-runs/${encodeURIComponent(initial.id)}`);
  }
  return mapValidationRun(current);
}

function mapTestCase(value: CurrentTestCase): TestCase {
  return {
    id: value.id,
    guardrail_id: value.guardrailId,
    name: value.name,
    policy_id: value.policyId,
    phase: value.phase,
    content: value.content,
    expected_decision: value.expectedDecision,
    origin: value.origin,
    updated_at: value.updatedAt,
    trusted_instruction: value.trustedInstruction,
    target_source: value.targetSource,
    query: value.query,
    grounding_sources: value.groundingSources,
    expected_reasoning_result: value.expectedReasoningResult,
    source_policy_id: value.sourcePolicyId,
    source_policy_version: value.sourcePolicyVersion,
    source_case_id: value.sourceCaseId,
    covered_rule_ids: value.coveredRuleIds,
    case_type: value.caseType,
    required: value.required,
    excluded: value.excluded,
  };
}
