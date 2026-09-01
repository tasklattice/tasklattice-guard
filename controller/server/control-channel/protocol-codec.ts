import type { ActionBinding, ActionBinding__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/ActionBinding.js";
import type { Artifact, Artifact__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/Artifact.js";
import type { ArtifactDependency, ArtifactDependency__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/ArtifactDependency.js";
import type { GuardrailPlan, GuardrailPlan__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/GuardrailPlan.js";
import type { IntegrationVerification } from "../generated/control-protocol/tasklattice/guard/control/v1/IntegrationVerification.js";
import type { PromptDefinition, PromptDefinition__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/PromptDefinition.js";
import type { RiskFinding__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/RiskFinding.js";
import type { RuntimeTraceStep__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/RuntimeTraceStep.js";
import type { TrafficScope } from "../generated/control-protocol/tasklattice/guard/control/v1/TrafficScope.js";
import type { ValidationCaseResult__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/ValidationCaseResult.js";
import type { ValidationMetrics__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/ValidationMetrics.js";
import type { ValidationTestCase } from "../generated/control-protocol/tasklattice/guard/control/v1/ValidationTestCase.js";

import type { ValidationCaseResult, ValidationMetrics } from "../domain/models.js";

/** Convert the Controller plan document into the generated transport type. */
export function planToWire(value: unknown): GuardrailPlan {
  const plan = record(value);
  return {
    guardrailId: string(plan.guardrail_id),
    guardrailVersion: number(plan.guardrail_version),
    compilerVersion: string(plan.compiler_version),
    safetyLevel: wireEnum("SAFETY_LEVEL", plan.safety_level),
    outputDelivery: wireEnum("OUTPUT_DELIVERY_MODE", plan.output_delivery),
    steps: records(plan.steps).map((step) => ({
      id: string(step.id),
      capability: string(step.capability),
      contractRef: string(step.contract_ref),
      phases: strings(step.phases).map((phase) => wireEnum("GUARDRAIL_PHASE", phase)),
      onUnsafe: wireEnum("ENFORCEMENT_ACTION", step.on_unsafe),
      trigger: triggerToWire(step.trigger),
      parameters: pairsToWire(step.parameters),
    })),
    modules: records(plan.modules).map((module) => ({
      id: string(module.id),
      module: wireEnum("POLICY_MODULE", module.module),
      phase: wireEnum("GUARDRAIL_PHASE", module.phase),
      stepIds: strings(module.step_ids),
      dependsOn: strings(module.depends_on),
      inputView: wireEnum("CONTENT_VIEW", module.input_view),
      requiredForRelease: Boolean(module.required_for_release),
      timeoutMs: number(module.timeout_ms),
      failureMode: wireEnum("FAILURE_MODE", module.failure_mode),
    })),
    reasoningPolicies: records(plan.reasoning_policies).map((policy) => ({
      id: string(policy.id),
      policyId: string(policy.policy_id),
      policyVersion: string(policy.policy_version),
      confidenceThreshold: number(policy.confidence_threshold),
    })),
    policyVersions: records(plan.policy_versions).map((policy) => ({
      policyId: string(policy.policy_id),
      version: string(policy.version),
      name: string(policy.name),
      source: string(policy.source),
      colangVersion: string(policy.colang_version),
      sources: records(policy.sources).map((source) => ({ path: string(source.path), content: string(source.content) })),
      parameterSchema: pairsToWire(policy.parameter_schema),
      railBindings: records(policy.rail_bindings).map((binding) => ({
        railType: wireEnum("RAIL_TYPE", binding.rail_type),
        flowName: string(binding.flow_name),
        executionMode: wireEnum("POLICY_EXECUTION_MODE", binding.execution_mode),
        onUnsafe: wireEnum("ENFORCEMENT_ACTION", binding.on_unsafe),
        ...(optionalString(binding.parallel_group) === null ? {} : { parallelGroup: string(binding.parallel_group) }),
        ...(binding.priority === undefined || binding.priority === null ? {} : { priority: number(binding.priority) }),
        timeoutMs: number(binding.timeout_ms),
        failureMode: wireEnum("FAILURE_MODE", binding.failure_mode),
        required: Boolean(binding.required),
        dependsOn: strings(binding.depends_on),
      })),
      actionReferences: records(policy.action_references).map((reference) => ({
        name: string(reference.name), version: string(reference.version),
      })),
      evaluationContracts: strings(policy.evaluation_contracts),
      promptDependencies: strings(policy.prompt_dependencies),
      executionContract: pairsToWire(policy.execution_contract),
      testCases: pairsToWire(policy.test_cases),
      checksum: string(policy.checksum),
    })),
    policyBindings: records(plan.policy_bindings).map((binding) => ({
      policyId: string(binding.policy_id),
      policyVersion: string(binding.policy_version),
      ...(optionalString(binding.action) === null ? {} : { action: wireEnum("ENFORCEMENT_ACTION", binding.action) }),
      parameterValues: pairsToWire(binding.parameter_values),
      enabledRuleIds: strings(binding.enabled_rule_ids),
      ruleActions: pairsToWire(binding.rule_actions),
      enabledRails: strings(binding.enabled_rails).map((rail) => wireEnum("RAIL_TYPE", rail)),
    })),
  };
}

/** Convert the generated transport plan back to the persisted domain document. */
export function planFromWire(plan: GuardrailPlan__Output): Record<string, unknown> {
  return {
    guardrail_id: plan.guardrailId,
    guardrail_version: plan.guardrailVersion,
    compiler_version: plan.compilerVersion,
    safety_level: domainEnum("SAFETY_LEVEL", plan.safetyLevel),
    output_delivery: domainEnum("OUTPUT_DELIVERY_MODE", plan.outputDelivery),
    steps: plan.steps.map((step) => ({
      id: step.id,
      capability: step.capability,
      contract_ref: step.contractRef,
      phases: step.phases.map((phase) => domainEnum("GUARDRAIL_PHASE", phase)),
      on_unsafe: domainEnum("ENFORCEMENT_ACTION", step.onUnsafe),
      trigger: triggerFromWire(step.trigger),
      parameters: pairsFromWire(step.parameters),
    })),
    modules: plan.modules.map((module) => ({
      id: module.id,
      module: domainEnum("POLICY_MODULE", module.module),
      phase: domainEnum("GUARDRAIL_PHASE", module.phase),
      step_ids: [...module.stepIds],
      depends_on: [...module.dependsOn],
      input_view: domainEnum("CONTENT_VIEW", module.inputView),
      required_for_release: module.requiredForRelease,
      timeout_ms: module.timeoutMs,
      failure_mode: domainEnum("FAILURE_MODE", module.failureMode),
    })),
    reasoning_policies: plan.reasoningPolicies.map((policy) => ({
      id: policy.id,
      policy_id: policy.policyId,
      policy_version: policy.policyVersion,
      confidence_threshold: policy.confidenceThreshold,
    })),
    policy_versions: plan.policyVersions.map((policy) => ({
      policy_id: policy.policyId,
      version: policy.version,
      name: policy.name,
      source: policy.source,
      colang_version: policy.colangVersion,
      sources: policy.sources.map((source) => ({ path: source.path, content: source.content })),
      parameter_schema: pairsFromWire(policy.parameterSchema),
      rail_bindings: policy.railBindings.map((binding) => ({
        rail_type: domainEnum("RAIL_TYPE", binding.railType),
        flow_name: binding.flowName,
        execution_mode: domainEnum("POLICY_EXECUTION_MODE", binding.executionMode),
        on_unsafe: domainEnum("ENFORCEMENT_ACTION", binding.onUnsafe),
        ...(binding.parallelGroup === undefined ? {} : { parallel_group: binding.parallelGroup }),
        ...(binding.priority === undefined ? {} : { priority: binding.priority }),
        timeout_ms: binding.timeoutMs,
        failure_mode: domainEnum("FAILURE_MODE", binding.failureMode),
        required: binding.required,
        depends_on: [...binding.dependsOn],
      })),
      action_references: policy.actionReferences.map((reference) => ({ name: reference.name, version: reference.version })),
      evaluation_contracts: [...policy.evaluationContracts],
      prompt_dependencies: [...policy.promptDependencies],
      execution_contract: pairsFromWire(policy.executionContract),
      test_cases: pairsFromWire(policy.testCases),
      checksum: policy.checksum,
    })),
    policy_bindings: plan.policyBindings.map((binding) => ({
      policy_id: binding.policyId,
      policy_version: binding.policyVersion,
      ...(binding.action === undefined ? {} : { action: domainEnum("ENFORCEMENT_ACTION", binding.action) }),
      parameter_values: pairsFromWire(binding.parameterValues),
      enabled_rule_ids: [...binding.enabledRuleIds],
      rule_actions: pairsFromWire(binding.ruleActions),
      enabled_rails: binding.enabledRails.map((rail) => domainEnum("RAIL_TYPE", rail)),
    })),
  };
}

export function artifactToWire(input: unknown): Artifact {
  const value = record(input);
  return {
    artifactId: string(value.id),
    guardrailId: string(value.guardrailId),
    guardrailVersion: number(value.guardrailVersion),
    generation: string(value.generation),
    compilerVersion: string(value.compilerVersion),
    nemoVersion: string(value.nemoVersion),
    runtimeProfile: string(value.runtimeProfile),
    plan: planToWire(value.plan),
    configYaml: string(value.configYaml),
    colangContent: string(value.colangContent),
    prompts: records(value.prompts).map(promptToWire),
    actionBindings: records(value.actionBindings).map(actionBindingToWire),
    dependencyManifest: arrays(value.dependencyManifest).map(dependencyToWire),
    checksum: string(value.checksum),
    signature: string(value.signature),
  };
}

export function artifactFromWire(artifact: Artifact__Output): Record<string, unknown> {
  if (!artifact.plan) throw new Error("Artifact is missing its Guardrail Plan.");
  return {
    guardrailId: artifact.guardrailId,
    guardrailVersion: artifact.guardrailVersion,
    generation: number(artifact.generation),
    compilerVersion: artifact.compilerVersion,
    nemoVersion: artifact.nemoVersion,
    runtimeProfile: artifact.runtimeProfile,
    plan: planFromWire(artifact.plan),
    configYaml: artifact.configYaml,
    colangContent: artifact.colangContent,
    prompts: artifact.prompts.map(promptFromWire),
    actionBindings: artifact.actionBindings.map(actionBindingFromWire),
    dependencyManifest: artifact.dependencyManifest.map((item) => [item.kind, item.name, item.version]),
  };
}

export function trafficScopeToWire(value: unknown): TrafficScope {
  const scope = record(value);
  const entries = records(scope.conditions);
  return {
    combinator: wireEnum("TRAFFIC_COMBINATOR", scope.combinator ?? "and"),
    conditions: entries.filter((item) => !("combinator" in item)).map((condition) => ({
      field: string(condition.field),
      key: string(condition.key),
      operator: wireEnum("TRAFFIC_OPERATOR", condition.operator),
      value: string(condition.value),
    })),
    groups: entries.filter((item) => "combinator" in item).map(trafficScopeToWire),
  };
}

export function integrationVerificationToWire(value: unknown): IntegrationVerification {
  const verification = record(value);
  return { credentials: records(verification.credentials).map((credential) => ({
    id: string(credential.id),
    sha256: string(credential.sha256),
    keyHint: string(credential.keyHint),
    createdAt: string(credential.createdAt),
    ...(optionalString(credential.revokedAt) === null ? {} : { revokedAt: string(credential.revokedAt) }),
  })) };
}

export function validationTestToWire(value: unknown): ValidationTestCase {
  const item = record(value);
  return {
    id: string(item.id),
    name: string(item.name),
    policyId: string(item.policyId),
    phase: wireEnum("GUARDRAIL_PHASE", item.phase),
    content: string(item.content),
    expectedDecision: wireEnum("VALIDATION_DECISION", item.expectedDecision),
    trustedInstruction: string(item.trustedInstruction),
    targetSource: wireEnum("TARGET_SOURCE", item.targetSource),
    query: string(item.query),
    groundingSources: strings(item.groundingSources),
    ...(optionalString(item.expectedReasoningResult) === null ? {} : {
      expectedReasoningResult: wireEnum("AUTOMATED_REASONING_RESULT", item.expectedReasoningResult),
    }),
    caseType: string(item.caseType),
    required: Boolean(item.required),
    ...(optionalString(item.expectedFailure) === null ? {} : {
      expectedFailure: wireEnum("VALIDATION_FAILURE", item.expectedFailure),
    }),
    ...(optionalString(item.concurrencyGroup) === null ? {} : { concurrencyGroup: string(item.concurrencyGroup) }),
    ...(optionalString(item.sourcePolicyId) === null ? {} : { sourcePolicyId: string(item.sourcePolicyId) }),
    ...(optionalString(item.sourcePolicyVersion) === null ? {} : { sourcePolicyVersion: string(item.sourcePolicyVersion) }),
    ...(optionalString(item.sourceCaseId) === null ? {} : { sourceCaseId: string(item.sourceCaseId) }),
    coveredRuleIds: strings(item.coveredRuleIds),
  };
}

export function validationMetricsFromWire(value: ValidationMetrics__Output): ValidationMetrics {
  return {
    total: value.total,
    passed: value.passed,
    complianceRate: value.complianceRate,
    falsePositiveRate: value.falsePositiveRate,
    falseNegativeRate: value.falseNegativeRate,
    escalationRate: value.escalationRate,
    p95LatencyMs: value.p95LatencyMs,
  };
}

export function validationCaseFromWire(value: ValidationCaseResult__Output): ValidationCaseResult {
  return {
    caseId: value.caseId,
    name: value.name,
    policyId: value.policyId,
    expectedDecision: domainEnum("VALIDATION_DECISION", value.expectedDecision),
    actualDecision: domainEnum("VALIDATION_DECISION", value.actualDecision),
    passed: value.passed,
    evaluatorIds: [...value.evaluatorIds],
    latencyMs: value.latencyMs,
    reason: value.reason,
    phase: domainEnum("GUARDRAIL_PHASE", value.phase) === "output" ? "output" : "input",
    inputContent: value.inputContent,
    action: domainEnum("ENFORCEMENT_ACTION", value.action),
    outputContent: value.outputContent,
    findings: value.findings.map(findingFromWire),
    trace: value.trace.map(traceFromWire),
    trustedInstruction: value.trustedInstruction,
    targetSource: domainEnum("TARGET_SOURCE", value.targetSource),
    query: value.query,
    groundingSources: [...value.groundingSources],
    expectedReasoningResult: optionalDomainEnum("AUTOMATED_REASONING_RESULT", value.expectedReasoningResult),
    actualReasoningResult: optionalDomainEnum("AUTOMATED_REASONING_RESULT", value.actualReasoningResult),
    caseType: value.caseType,
    required: value.required,
    expectedFailure: optionalDomainEnum("VALIDATION_FAILURE", value.expectedFailure),
    actualFailure: optionalDomainEnum("VALIDATION_FAILURE", value.actualFailure),
    concurrencyGroup: value.concurrencyGroup ?? null,
    sourcePolicyId: value.sourcePolicyId ?? null,
    sourcePolicyVersion: value.sourcePolicyVersion ?? null,
    sourceCaseId: value.sourceCaseId ?? null,
    coveredRuleIds: [...value.coveredRuleIds],
    matchedRuleIds: [...value.matchedRuleIds],
    evaluationContracts: [...value.evaluationContracts],
    escalated: value.escalated,
    modelInvocations: value.modelInvocations,
  };
}

export function validationStatusFromWire(value: unknown): "passed" | "failed" {
  return domainEnum("VALIDATION_STATUS", value) === "passed" ? "passed" : "failed";
}

function promptToWire(prompt: Record<string, unknown>): PromptDefinition {
  return {
    task: string(prompt.task),
    content: string(prompt.content),
    ...(optionalString(prompt.output_parser) === null ? {} : { outputParser: string(prompt.output_parser) }),
    ...(prompt.max_tokens === undefined || prompt.max_tokens === null ? {} : { maxTokens: number(prompt.max_tokens) }),
  };
}

function promptFromWire(prompt: PromptDefinition__Output): Record<string, unknown> {
  return {
    task: prompt.task,
    content: prompt.content,
    ...(prompt.outputParser === undefined ? {} : { output_parser: prompt.outputParser }),
    ...(prompt.maxTokens === undefined ? {} : { max_tokens: prompt.maxTokens }),
  };
}

function actionBindingToWire(binding: Record<string, unknown>): ActionBinding {
  return {
    id: string(binding.id),
    capability: string(binding.capability),
    contractRef: string(binding.contract_ref),
    phases: strings(binding.phases).map((phase) => wireEnum("GUARDRAIL_PHASE", phase)),
    onUnsafe: wireEnum("ENFORCEMENT_ACTION", binding.on_unsafe),
    trigger: triggerToWire(binding.trigger),
    timeoutMs: number(binding.timeout_ms),
    parameters: pairsToWire(binding.parameters),
    ...(optionalString(binding.policy_id) === null ? {} : { policyId: string(binding.policy_id) }),
    ...(optionalString(binding.policy_version) === null ? {} : { policyVersion: string(binding.policy_version) }),
    ...(optionalString(binding.flow_name) === null ? {} : { flowName: string(binding.flow_name) }),
    ...(optionalString(binding.action_name) === null ? {} : { actionName: string(binding.action_name) }),
    ...(optionalString(binding.action_version) === null ? {} : { actionVersion: string(binding.action_version) }),
    ...(optionalString(binding.parallel_group) === null ? {} : { parallelGroup: string(binding.parallel_group) }),
    executionMode: wireEnum("POLICY_EXECUTION_MODE", binding.execution_mode),
    failureMode: wireEnum("FAILURE_MODE", binding.failure_mode),
    dependsOn: strings(binding.depends_on),
    ...(optionalString(binding.result_var) === null ? {} : { resultVar: string(binding.result_var) }),
  };
}

function actionBindingFromWire(binding: ActionBinding__Output): Record<string, unknown> {
  return {
    id: binding.id,
    capability: binding.capability,
    contract_ref: binding.contractRef,
    phases: binding.phases.map((phase) => domainEnum("GUARDRAIL_PHASE", phase)),
    on_unsafe: domainEnum("ENFORCEMENT_ACTION", binding.onUnsafe),
    trigger: triggerFromWire(binding.trigger),
    timeout_ms: binding.timeoutMs,
    parameters: pairsFromWire(binding.parameters),
    ...(binding.policyId === undefined ? {} : { policy_id: binding.policyId }),
    ...(binding.policyVersion === undefined ? {} : { policy_version: binding.policyVersion }),
    ...(binding.flowName === undefined ? {} : { flow_name: binding.flowName }),
    ...(binding.actionName === undefined ? {} : { action_name: binding.actionName }),
    ...(binding.actionVersion === undefined ? {} : { action_version: binding.actionVersion }),
    ...(binding.parallelGroup === undefined ? {} : { parallel_group: binding.parallelGroup }),
    execution_mode: domainEnum("POLICY_EXECUTION_MODE", binding.executionMode),
    failure_mode: domainEnum("FAILURE_MODE", binding.failureMode),
    depends_on: [...binding.dependsOn],
    ...(binding.resultVar === undefined ? {} : { result_var: binding.resultVar }),
  };
}

function triggerToWire(value: unknown): NonNullable<ActionBinding["trigger"]> {
  const trigger = record(value);
  return {
    type: wireEnum("EVALUATION_TRIGGER_TYPE", trigger.type),
    ...(optionalString(trigger.step_ref) === null ? {} : { stepRef: string(trigger.step_ref) }),
    verdicts: strings(trigger.verdicts).map((verdict) => wireEnum("EVALUATOR_VERDICT", verdict)),
  };
}

function triggerFromWire(value: ActionBinding__Output["trigger"]): Record<string, unknown> {
  if (value === null) return { type: "always" };
  return {
    type: domainEnum("EVALUATION_TRIGGER_TYPE", value.type),
    ...(value.stepRef === undefined ? {} : { step_ref: value.stepRef }),
    verdicts: value.verdicts.map((verdict) => domainEnum("EVALUATOR_VERDICT", verdict)),
  };
}

function dependencyToWire(value: unknown[]): ArtifactDependency {
  return { kind: string(value[0]), name: string(value[1]), version: string(value[2]) };
}

function findingFromWire(value: RiskFinding__Output): Record<string, unknown> {
  return {
    risk: value.risk,
    taxonomy_id: value.taxonomyId,
    verdict: domainEnum("EVALUATOR_VERDICT", value.verdict),
    confidence: value.confidence ?? null,
    evidence: value.evidence,
    recommended_action: domainEnum("ENFORCEMENT_ACTION", value.recommendedAction),
    replacement: value.replacement ?? null,
    policy_id: value.policyId ?? null,
    rule_id: value.ruleId ?? null,
    grounding: value.grounding.map((item) => ({
      type: domainEnum("GROUNDING_FILTER_TYPE", item.type), score: item.score,
      threshold: item.threshold, detected: item.detected,
    })),
    claims: value.claims.map((item) => ({
      id: item.id, claim: item.claim, support: domainEnum("CLAIM_SUPPORT", item.support),
      confidence: item.confidence, source_block_ids: [...item.sourceBlockIds], rationale: item.rationale,
    })),
    reasoning: value.reasoning.map((item) => ({
      id: item.id,
      result: domainEnum("AUTOMATED_REASONING_RESULT", item.result),
      confidence: item.confidence,
      translation: item.translation == null ? null : {
        premises: [...item.translation.premises], claims: [...item.translation.claims], untranslated: [...item.translation.untranslated],
      },
      supporting_rules: item.supportingRules.map(snakeRecord),
      contradicting_rules: item.contradictingRules.map(snakeRecord),
      claims_true_scenario: item.claimsTrueScenario == null ? null : { variable_values: pairsFromWire(item.claimsTrueScenario.variableValues) },
      claims_false_scenario: item.claimsFalseScenario == null ? null : { variable_values: pairsFromWire(item.claimsFalseScenario.variableValues) },
      message: item.message,
    })),
    provider_evidence: value.providerEvidence.map(snakeRecord),
  };
}

function traceFromWire(value: RuntimeTraceStep__Output): Record<string, unknown> {
  const trace = snakeRecord(value);
  if (value.verdict !== undefined) trace.verdict = domainEnum("EVALUATOR_VERDICT", value.verdict);
  if (value.route !== undefined) trace.route = domainEnum("ROUTE_DECISION", value.route);
  if (value.railType !== undefined) trace.rail_type = domainEnum("RAIL_TYPE", value.railType);
  return trace;
}

function pairsToWire(value: unknown): Array<{ key: string; value: string }> {
  return arrays(value).map((pair) => ({ key: string(pair[0]), value: string(pair[1]) }));
}

function pairsFromWire(value: ReadonlyArray<{ key: string; value: string }>): Array<[string, string]> {
  return value.map((pair) => [pair.key, pair.value]);
}

function wireEnum<T extends string | number>(prefix: string, value: unknown): T {
  const normalized = string(value).trim().toUpperCase();
  if (!normalized) throw new Error(`${prefix} requires a value.`);
  return `${prefix}_${normalized}` as T;
}

function domainEnum(prefix: string, value: unknown): string {
  const normalized = string(value);
  const marker = `${prefix}_`;
  if (!normalized.startsWith(marker)) throw new Error(`Invalid ${prefix} value ${normalized}.`);
  return normalized.slice(marker.length).toLowerCase();
}

function optionalDomainEnum(prefix: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const parsed = domainEnum(prefix, value);
  return parsed === "unspecified" ? null : parsed;
}

function snakeRecord(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (key.startsWith("_")) return [];
    const converted = Array.isArray(item)
      ? item.map((entry) => entry && typeof entry === "object" ? snakeRecord(entry as object) : entry)
      : item && typeof item === "object"
        ? snakeRecord(item as object)
        : item;
    return [[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), converted]];
  }));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
function arrays(value: unknown): unknown[][] { return Array.isArray(value) ? value.filter(Array.isArray) as unknown[][] : []; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.map(string) : []; }
function string(value: unknown): string { return typeof value === "string" ? value : String(value ?? ""); }
function optionalString(value: unknown): string | null { return typeof value === "string" && value.length ? value : null; }
function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
