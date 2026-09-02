import type { PolicyDto } from "../policy-catalog/catalog.js";
import type { ProgrammablePolicySnapshot } from "../policy-studio/model.js";
import { flowRuleId } from "../policy-studio/model.js";

export const enforcementActions = [
  "pass", "redact", "rewrite", "regenerate", "redirect", "reject", "fallback", "clarify",
] as const;

export type EnforcementAction = typeof enforcementActions[number];
export type GuardrailRail = "input" | "output" | "retrieval" | "dialog" | "execution";

export type GuardrailPolicyBindingConfig = {
  policyId: string;
  policyVersion: string;
  action: EnforcementAction | null;
  parameterValues: Record<string, string>;
  enabledRuleIds: string[];
  ruleActions: Record<string, EnforcementAction>;
  enabledRails: GuardrailRail[];
  reasoningPolicy: {
    policyId: string;
    policyVersion: string;
    confidenceThreshold: number;
  } | null;
};

export type GuardrailPurposeDetails = {
  audience: string;
  tasks: string;
  protect: string;
  outOfScope: string;
};

export const protectionIds = ["secrets", "pii", "builtin_content_filter", "prompt_injection", "jailbreak"] as const;
export type ProtectionId = typeof protectionIds[number];

/**
 * Controller-owned product draft. `protections` remains optional only so an
 * existing pre-control-plane-split row can be migrated without data loss.
 * New writes always persist the full policy binding contract.
 */
export type GuardrailDraftConfig = {
  protections?: ProtectionId[] | undefined;
  purposeDetails: GuardrailPurposeDetails;
  allowedTopics: string[];
  restrictedTopics: string[];
  policyBindings: GuardrailPolicyBindingConfig[];
  safetyLevel: "balanced" | "strict";
  outputDelivery: "interruptible" | "window_buffered" | "full_buffered";
  customContentRules?: Array<{
    id: string;
    phases: Array<"input" | "output">;
    detector: "keyword" | "regex";
    keywords?: string[] | undefined;
    expression?: string | undefined;
    action: EnforcementAction;
    replacement?: string | undefined;
  }> | undefined;
};

type RuntimeCapability = {
  risk: string;
  policyId: string;
  defaultPhases: Array<"input" | "output">;
  defaultAction: EnforcementAction;
  stages: Array<"deterministic" | "fast_semantic" | "deep_judge">;
  module: "data_protection" | "interaction_safety" | "business_assurance";
};

const capabilities: RuntimeCapability[] = [
  capability("secrets", "builtin-secrets", ["input", "output"], "reject", ["deterministic"], "data_protection"),
  capability("pii", "builtin-pii", ["input", "output"], "redact", ["deterministic", "fast_semantic"], "data_protection"),
  capability("prompt_injection", "builtin-prompt-injection", ["input"], "reject", ["fast_semantic", "deep_judge"], "interaction_safety"),
  capability("indirect_prompt_injection", "builtin-indirect-prompt-injection", ["input"], "reject", ["deterministic"], "interaction_safety"),
  capability("jailbreak", "builtin-jailbreak", ["input"], "reject", ["fast_semantic", "deep_judge"], "interaction_safety"),
  capability("system_prompt_leakage", "builtin-system-prompt-leakage", ["output"], "reject", ["deterministic"], "data_protection"),
  capability("content_safety", "builtin-content-safety", ["input", "output"], "reject", ["fast_semantic"], "interaction_safety"),
  capability("topic_control", "builtin-topic-safety", ["input", "output"], "redirect", ["deterministic", "deep_judge"], "business_assurance"),
  capability("company_policy", "builtin-company-policy", ["input", "output"], "reject", ["deep_judge"], "business_assurance"),
  capability("contextual_grounding", "builtin-contextual-grounding", ["output"], "regenerate", ["deep_judge"], "business_assurance"),
  capability("automated_reasoning", "builtin-automated-reasoning", ["output"], "rewrite", ["deep_judge"], "business_assurance"),
];

const capabilityByPolicyId = new Map(capabilities.map((item) => [item.policyId, item]));
const capabilityByRisk = new Map(capabilities.map((item) => [item.risk, item]));
const moduleTimeout = { data_protection: 750, interaction_safety: 2_500, business_assurance: 5_000 } as const;

type PlanStep = {
  id: string;
  risk: string;
  stage: "deterministic" | "fast_semantic" | "deep_judge";
  phases: Array<"input" | "output">;
  on_unsafe: EnforcementAction;
  escalation: "never" | "on_uncertain" | "always";
  threshold?: number;
  parameters: Array<[string, string]>;
};

export function normalizeGuardrailDraft(value: unknown): GuardrailDraftConfig {
  const source = record(value);
  const legacy = stringArray(source.protections).filter((item): item is ProtectionId => protectionIds.includes(item as ProtectionId));
  const policyBindings = Array.isArray(source.policyBindings)
    ? source.policyBindings.map(normalizeBinding)
    : legacy.map(legacyBinding);
  return {
    ...(legacy.length ? { protections: legacy } : {}),
    purposeDetails: normalizePurposeDetails(source.purposeDetails),
    allowedTopics: stringArray(source.allowedTopics),
    restrictedTopics: stringArray(source.restrictedTopics),
    policyBindings,
    safetyLevel: source.safetyLevel === "strict" ? "strict" : "balanced",
    outputDelivery: source.outputDelivery === "interruptible" || source.outputDelivery === "window_buffered"
      ? source.outputDelivery
      : "full_buffered",
    customContentRules: normalizeCustomContentRules(source.customContentRules),
  };
}

/** Convert the product draft into the immutable contract compiled by Runner. */
export function buildGuardrailPlan(input: {
  guardrailId: string;
  guardrailVersion: number;
  purpose?: string;
  draft: GuardrailDraftConfig;
  policies?: readonly PolicyDto[];
  programmablePolicies?: readonly ProgrammablePolicySnapshot[];
}): Record<string, unknown> {
  const draft = normalizeGuardrailDraft(input.draft);
  const policyById = new Map((input.policies ?? []).map((item) => [item.id, item]));
  const programmableByKey = new Map((input.programmablePolicies ?? []).map((item) => [`${item.policy_id}@${item.version}`, item]));
  const bindings = draft.policyBindings.length ? draft.policyBindings : (draft.protections ?? []).map(legacyBinding);
  if (!bindings.length) throw new Error("Select at least one Policy before compiling a Guardrail.");

  const resolved = new Map<string, { capability: RuntimeCapability; binding: GuardrailPolicyBindingConfig }>();
  const declarative: Array<{ binding: GuardrailPolicyBindingConfig; policy: PolicyDto }> = [];
  const programmable: Array<{ binding: GuardrailPolicyBindingConfig; policy: ProgrammablePolicySnapshot }> = [];
  for (const binding of bindings) {
    if (binding.policyId.startsWith("controller-protection:")) {
      const legacyRisk = binding.policyId.slice("controller-protection:".length);
      if (legacyRisk === "builtin_content_filter") {
        const contentFilter: RuntimeCapability = {
          risk: legacyRisk, policyId: "", defaultPhases: ["input", "output"],
          defaultAction: "reject", stages: ["deterministic"], module: "interaction_safety",
        };
        resolved.set(legacyRisk, { capability: contentFilter, binding });
        continue;
      }
    }
    const programmablePolicy = programmableByKey.get(`${binding.policyId}@${binding.policyVersion}`);
    if (programmablePolicy) {
      validateProgrammableBinding(binding, programmablePolicy);
      programmable.push({ binding, policy: programmablePolicy });
      const nativeRisk = Object.fromEntries(programmablePolicy.execution_contract).native_risk;
      const native = nativeRisk ? capabilityByRisk.get(nativeRisk) : undefined;
      if (native) resolved.set(native.risk, { capability: native, binding });
      continue;
    }
    const catalogPolicy = policyById.get(binding.policyId);
    if (input.policies !== undefined) {
      if (!catalogPolicy) throw new Error(`Policy ${binding.policyId}@${binding.policyVersion} is unavailable in the Controller catalog.`);
      validateCatalogBinding(binding, catalogPolicy);
    }
    const native = capabilityByPolicyId.get(binding.policyId);
    if (native) {
      resolved.set(native.risk, { capability: native, binding });
      continue;
    }
    const policy = catalogPolicy;
    if (!policy) throw new Error(`Policy ${binding.policyId}@${binding.policyVersion} is unavailable in the Controller catalog.`);
    if (input.policies === undefined) validateCatalogBinding(binding, policy);
    declarative.push({ binding, policy });
  }
  if (declarative.length) {
    const contentFilter: RuntimeCapability = {
      risk: "builtin_content_filter", policyId: "", defaultPhases: ["input", "output"],
      defaultAction: "reject", stages: ["deterministic"], module: "interaction_safety",
    };
    resolved.set(contentFilter.risk, { capability: contentFilter, binding: declarative[0]!.binding });
  }

  const steps: PlanStep[] = [];
  for (const { capability: definition, binding } of resolved.values()) {
    const phases = phasesFor(definition, binding, declarative);
    // Deep judges require an explicitly configured provider. The same plan can
    // still run its local/fast stage when that optional provider is absent.
    const stages = definition.stages.filter((stage) => stage !== "deep_judge" || definition.stages.length === 1);
    const parameters = parametersFor(definition.risk, binding, draft, input.purpose ?? "", declarative);
    for (const stage of stages) {
      steps.push({
        id: `${definition.risk}:${stage.replaceAll("_", "-")}`,
        risk: definition.risk,
        stage,
        phases,
        on_unsafe: binding.action ?? definition.defaultAction,
        escalation: "never",
        ...(stage === "fast_semantic" ? { threshold: 0.85 } : {}),
        parameters,
      });
    }
  }

  const modules = (["input", "output"] as const).flatMap((phase) =>
    (["data_protection", "interaction_safety", "business_assurance"] as const).flatMap((module) => {
      const stepIds = steps.filter((step) => step.phases.includes(phase) && moduleForRisk(step.risk) === module).map((step) => step.id);
      if (!stepIds.length) return [];
      return [{
        id: `${module}:${phase}`, module, phase, step_ids: stepIds, depends_on: [], input_view: "original",
        required_for_release: true, timeout_ms: moduleTimeout[module], failure_mode: "fail_closed",
      }];
    }),
  );
  const reasoningPolicies = bindings.flatMap((binding) => binding.reasoningPolicy ? [{
    id: `automated-reasoning:${binding.reasoningPolicy.policyId}:${binding.reasoningPolicy.policyVersion}`,
    policy_id: binding.reasoningPolicy.policyId,
    policy_version: binding.reasoningPolicy.policyVersion,
    confidence_threshold: binding.reasoningPolicy.confidenceThreshold,
  }] : []);
  return {
    guardrail_id: input.guardrailId,
    guardrail_version: input.guardrailVersion,
    compiler_version: "tasklattice-controller-plan-v2",
    safety_level: draft.safetyLevel,
    output_delivery: draft.outputDelivery,
    steps,
    modules,
    reasoning_policies: reasoningPolicies,
    policy_versions: programmable.map(({ policy }) => ({
      policy_id: policy.policy_id,
      version: policy.version,
      name: policy.name,
      source: policy.source,
      colang_version: policy.colang_version,
      sources: policy.sources,
      parameter_schema: policy.parameter_schema.map((item) => [item.name, item.kind]),
      rail_bindings: policy.rail_bindings,
      action_references: policy.action_references,
      model_dependencies: policy.model_dependencies,
      prompt_dependencies: policy.prompt_dependencies,
      execution_contract: policy.execution_contract,
      test_cases: policy.test_cases.map((item) => [item.name, item.expected_decision]),
      checksum: policy.checksum,
    })),
    policy_bindings: bindings.map((binding) => ({
      policy_id: binding.policyId,
      policy_version: binding.policyVersion,
      action: binding.action,
      parameter_values: Object.entries(binding.parameterValues).sort(([left], [right]) => left.localeCompare(right)),
      enabled_rule_ids: binding.enabledRuleIds,
      rule_actions: Object.entries(binding.ruleActions).sort(([left], [right]) => left.localeCompare(right)),
      enabled_rails: binding.enabledRails,
    })),
  };
}

function parametersFor(
  risk: string,
  binding: GuardrailPolicyBindingConfig,
  draft: GuardrailDraftConfig,
  purpose: string,
  declarative: Array<{ binding: GuardrailPolicyBindingConfig; policy: PolicyDto }>,
): Array<[string, string]> {
  if (risk === "builtin_content_filter") {
    return [
      ["policy_versions_json", JSON.stringify(Object.fromEntries(declarative.map((item) => [item.binding.policyId, item.policy.version])))],
      ["policy_ids", declarative.map((item) => item.binding.policyId).join("\n")],
      ["enabled_rules_json", JSON.stringify(Object.fromEntries(declarative.map((item) => [item.binding.policyId, item.binding.enabledRuleIds])))],
      ["rule_actions_json", JSON.stringify(Object.fromEntries(declarative.filter((item) => Object.keys(item.binding.ruleActions).length).map((item) => [item.binding.policyId, item.binding.ruleActions])))],
      ["policy_parameters_json", JSON.stringify(Object.fromEntries(declarative.filter((item) => Object.keys(item.binding.parameterValues).length).map((item) => [item.binding.policyId, item.binding.parameterValues])))],
      ["custom_rules_json", JSON.stringify(draft.customContentRules ?? [])],
    ];
  }
  if (risk === "topic_control" || risk === "company_policy") {
    return [
      ["purpose", purpose],
      ["purpose_audience", draft.purposeDetails.audience],
      ["purpose_tasks", draft.purposeDetails.tasks],
      ["purpose_protect", draft.purposeDetails.protect],
      ["purpose_out_of_scope", draft.purposeDetails.outOfScope],
      ["allowed_topics", draft.allowedTopics.join("\n")],
      ["restricted_topics", draft.restrictedTopics.join("\n")],
    ];
  }
  if (risk === "contextual_grounding") {
    return [["grounding_threshold", binding.parameterValues.grounding_threshold ?? "0.7"], ["relevance_threshold", binding.parameterValues.relevance_threshold ?? "0.7"]];
  }
  if (risk === "automated_reasoning" && binding.reasoningPolicy) {
    return [["policy_snapshot_id", `automated-reasoning:${binding.reasoningPolicy.policyId}:${binding.reasoningPolicy.policyVersion}`]];
  }
  return [];
}

function phasesFor(
  capability: RuntimeCapability,
  binding: GuardrailPolicyBindingConfig,
  declarative: Array<{ binding: GuardrailPolicyBindingConfig; policy: PolicyDto }>,
): Array<"input" | "output"> {
  if (capability.risk === "builtin_content_filter") {
    const selected = new Set(declarative.flatMap(({ binding: item, policy }) => {
      const enabled = item.enabledRails.length ? item.enabledRails : policy.stages;
      return policy.stages.filter((phase) => enabled.includes(phase));
    }));
    return (["input", "output"] as const).filter((phase) => selected.has(phase));
  }
  const enabled = binding.enabledRails.filter((item): item is "input" | "output" => item === "input" || item === "output");
  return enabled.length ? capability.defaultPhases.filter((phase) => enabled.includes(phase)) : capability.defaultPhases;
}

function normalizePurposeDetails(value: unknown): GuardrailPurposeDetails {
  const source = record(value);
  return {
    audience: stringValue(source.audience),
    tasks: stringValue(source.tasks),
    protect: stringValue(source.protect),
    outOfScope: stringValue(source.outOfScope),
  };
}

function normalizeCustomContentRules(value: unknown): GuardrailDraftConfig["customContentRules"] {
  if (!Array.isArray(value)) return [];
  const normalized: NonNullable<GuardrailDraftConfig["customContentRules"]> = [];
  value.forEach((item, index) => {
    const source = record(item);
    const detector: "keyword" | "regex" = stringValue(source.detector) === "regex" ? "regex" : "keyword";
    const phases: Array<"input" | "output"> = Array.isArray(source.phases)
      ? source.phases.filter((phase): phase is "input" | "output" => phase === "input" || phase === "output")
      : [];
    const normalizedPhases: Array<"input" | "output"> = phases.length ? phases : ["input"];
    const action = enforcementActions.includes(source.action as EnforcementAction)
      ? source.action as EnforcementAction
      : "reject";
    const id = stringValue(source.id) || `custom-rule-${index + 1}`;
    const replacement = stringValue(source.replacement) || undefined;
    if (detector === "keyword") {
      const keywords = stringArray(source.keywords);
      if (!keywords.length) return;
      normalized.push({ id, phases: normalizedPhases, detector, keywords, action, replacement });
      return;
    }
    const expression = stringValue(source.expression);
    if (!expression) return;
    normalized.push({ id, phases: normalizedPhases, detector, expression, action, replacement });
  });
  return normalized;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validateCatalogBinding(binding: GuardrailPolicyBindingConfig, policy: PolicyDto): void {
  if (binding.policyVersion !== policy.version) throw new Error(`Policy ${policy.id} must pin catalog version ${policy.version}; received ${binding.policyVersion}.`);
  const ruleIds = new Set(policy.rules.map((item) => item.id));
  const unknownRules = binding.enabledRuleIds.filter((item) => !ruleIds.has(item));
  if (unknownRules.length) throw new Error(`Policy ${policy.id} contains unknown enabled Rules: ${unknownRules.join(", ")}.`);
  if (!binding.enabledRuleIds.length) throw new Error(`Policy ${policy.id} must enable at least one Rule.`);
  for (const parameter of policy.parameters) {
    if (parameter.required && !(binding.parameterValues[parameter.name] ?? parameter.default ?? "").trim()) {
      throw new Error(`Policy ${policy.id} requires parameter ${parameter.name}.`);
    }
  }
}

function validateProgrammableBinding(binding: GuardrailPolicyBindingConfig, policy: ProgrammablePolicySnapshot): void {
  const ruleIds = new Set(policy.rail_bindings.map((item) => flowRuleId(item.rail_type, item.flow_name)));
  const unknownRules = binding.enabledRuleIds.filter((item) => !ruleIds.has(item));
  if (unknownRules.length) throw new Error(`Policy ${policy.policy_id} contains unknown enabled Rules: ${unknownRules.join(", ")}.`);
  if (!binding.enabledRuleIds.length) throw new Error(`Policy ${policy.policy_id} must enable at least one Rule.`);
  const enabledRails = binding.enabledRails.length ? binding.enabledRails : policy.rail_bindings.map((item) => item.rail_type);
  const outsideRails = binding.enabledRuleIds.filter((ruleId) => {
    const rail = policy.rail_bindings.find((item) => flowRuleId(item.rail_type, item.flow_name) === ruleId)?.rail_type;
    return Boolean(rail && !enabledRails.includes(rail));
  });
  if (outsideRails.length) throw new Error(`Policy ${policy.policy_id} enables Rules outside its enabled Rails.`);
  for (const parameter of policy.parameter_schema) {
    if (parameter.required && !(binding.parameterValues[parameter.name] ?? parameter.default ?? "").trim()) {
      throw new Error(`Policy ${policy.policy_id} requires parameter ${parameter.name}.`);
    }
  }
}

function legacyBinding(risk: ProtectionId): GuardrailPolicyBindingConfig {
  const native = capabilityByRisk.get(risk);
  const action: EnforcementAction = risk === "pii" ? "redact" : "reject";
  return {
    policyId: native?.policyId || `controller-protection:${risk}`,
    policyVersion: "tasklattice-controller-plan-v1",
    action,
    parameterValues: {}, enabledRuleIds: [risk], ruleActions: { [risk]: action },
    enabledRails: native?.defaultPhases ?? ["input", "output"], reasoningPolicy: null,
  };
}

function normalizeBinding(value: unknown): GuardrailPolicyBindingConfig {
  const source = record(value);
  const reasoning = record(source.reasoningPolicy);
  return {
    policyId: string(source.policyId),
    policyVersion: string(source.policyVersion),
    action: enforcementActions.includes(source.action as EnforcementAction) ? source.action as EnforcementAction : null,
    parameterValues: stringRecord(source.parameterValues),
    enabledRuleIds: stringArray(source.enabledRuleIds),
    ruleActions: actionRecord(source.ruleActions),
    enabledRails: stringArray(source.enabledRails).filter((item): item is GuardrailRail => ["input", "output", "retrieval", "dialog", "execution"].includes(item)),
    reasoningPolicy: reasoning.policyId && reasoning.policyVersion ? {
      policyId: string(reasoning.policyId), policyVersion: string(reasoning.policyVersion),
      confidenceThreshold: finite(reasoning.confidenceThreshold, 0.8),
    } : null,
  };
}

function capability(
  risk: string, policyId: string, defaultPhases: Array<"input" | "output">,
  defaultAction: EnforcementAction, stages: RuntimeCapability["stages"], module: RuntimeCapability["module"],
): RuntimeCapability { return { risk, policyId, defaultPhases, defaultAction, stages, module }; }

function moduleForRisk(risk: string): RuntimeCapability["module"] {
  return risk === "builtin_content_filter" ? "interaction_safety" : capabilityByRisk.get(risk)?.module ?? "interaction_safety";
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function stringRecord(value: unknown): Record<string, string> { return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string")); }
function actionRecord(value: unknown): Record<string, EnforcementAction> { return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, EnforcementAction] => enforcementActions.includes(entry[1] as EnforcementAction))); }
function finite(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
