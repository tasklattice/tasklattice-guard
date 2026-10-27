import { activePolicyParameters, policyBindingParameterIssues, resolveModelRuleParameters } from "../../shared/policy-parameters.js";
import type { PolicyDto } from "../policy-catalog/catalog.js";
import type { ProgrammablePolicySnapshot } from "../policy-studio/model.js";
import { flowRuleId } from "../policy-studio/model.js";
import { PHRASE_PARAMETER, PHRASE_POLICY_ID, parsePhraseEntries } from "../../shared/phrase-policy.js";
import { materializePolicyRules } from "./policy-rules.js";
import { scheduleChecks } from "./execution-plan.js";
import { EXPLICIT_VIEWS_PLAN_VERSION } from "./plan-semantics.js";
import { frozenBuiltInDefinition, planPolicyVersion } from "./policy-node.js";
import { isSplitTopicPolicy, TOPIC_ALLOW_RULE, TOPIC_DENY_RULE, topicMissingParameters, topicPolicyValues } from "../../shared/topic-policy.js";
import {
  enforcementActions,
  type EnforcementAction,
} from "../../shared/enforcement-action.generated.js";

// Preserve the domain module's public API while sourcing the closed wire
// vocabulary from the generated, cross-language contract.
export { enforcementActions };
export type { EnforcementAction };
export type GuardrailRail = "input" | "output" | "retrieval" | "dialog" | "execution";

export type ValidationExpectationOverride = {
  sourcePolicyVersion: string;
  reason: string;
  expectedDecision: "allow" | "block" | "transform" | "intervene";
  expectedOutputContent?: string | undefined;
  expectedMatches: Array<{ policyId: string; ruleId: string }>;
};

export type GuardrailPolicyBindingConfig = {
  policyId: string;
  policyVersion: string;
  action: EnforcementAction | null;
  parameterValues: Record<string, string>;
  enabledRuleIds: string[];
  /** Explicit local order; unlisted Rules follow in their pinned template order. */
  ruleOrder?: string[];
  /** Keyed by the inherited source Case ID, never by a runtime result. */
  testCaseOverrides?: Record<string, ValidationExpectationOverride>;
  ruleActions: Record<string, EnforcementAction>;
  enabledRails: GuardrailRail[];
  reasoningPolicy: {
    policyId: string;
    policyVersion: string;
    confidenceThreshold: number;
  } | null;
};

/** Controller-owned product draft expressed only as Policy bindings. */
export type GuardrailDraftConfig = {
  profileOrigin?: import("../../shared/protection-map.js").ProfileOrigin | undefined;
  allowedTopics: string[];
  topicControlMode?: "strict" | "permissive";
  restrictedTopics: string[];
  policyBindings: GuardrailPolicyBindingConfig[];
  safetyLevel: "balanced" | "strict";
  outputDelivery: "interruptible" | "window_buffered" | "full_buffered";
};

type RuntimeCapability = {
  capability: string;
  policyId: string;
  defaultPhases: Array<"input" | "output">;
  defaultAction: EnforcementAction;
  evaluations: RuntimeEvaluation[];
  module: "data_protection" | "interaction_safety" | "business_assurance";
};

type RuntimeEvaluation = {
  idSuffix: string;
  contractRef: string;
  potentiallyRemote: boolean;
  after?: { idSuffix: string; verdicts: Array<"not_matched" | "matched" | "unknown" | "error"> };
};

const contracts = {
  secretsExact: "tali.guard.secrets.exact.v1",
  piiExact: "tali.guard.pii.exact.v1",
  piiSemantic: "tali.guard.pii.semantic.v1",
  contentFilter: "tali.guard.content-filter.rules.v1",
  promptInjection: "tali.guard.prompt-injection.v1",
  indirectPromptInjection: "tali.guard.indirect-prompt-injection.v1",
  memoryPoisoning: "tali.guard.memory-poisoning.v1",
  jailbreak: "tali.guard.jailbreak.v1",
  systemPromptLeakage: "tali.guard.system-prompt-leakage.v1",
  contentSafety: "tali.guard.content-safety.v1",
  topicRules: "tali.guard.topic-control.rules.v1",
  topicSemantic: "tali.guard.topic-control.semantic.v1",
  contextualGrounding: "tali.guard.contextual-grounding.v1",
  automatedReasoning: "tali.guard.automated-reasoning.v1",
} as const;

const always = (idSuffix: string, contractRef: string, potentiallyRemote = false): RuntimeEvaluation => ({
  idSuffix, contractRef, potentiallyRemote,
});
const afterUnknown = (idSuffix: string, contractRef: string, previous: string, potentiallyRemote = true): RuntimeEvaluation => ({
  idSuffix, contractRef, potentiallyRemote, after: { idSuffix: previous, verdicts: ["unknown"] },
});

const capabilities: RuntimeCapability[] = [
  capability("secrets", "builtin-secrets", ["input", "output"], "block", [always("exact", contracts.secretsExact)], "data_protection"),
  capability("pii", "builtin-pii", ["input", "output"], "transform", [always("exact", contracts.piiExact), always("semantic", contracts.piiSemantic, true)], "data_protection"),
  capability("prompt_injection", "builtin-prompt-injection", ["input"], "block", [always("primary", contracts.promptInjection)], "interaction_safety"),
  capability("indirect_prompt_injection", "builtin-indirect-prompt-injection", ["input"], "block", [always("exact", contracts.indirectPromptInjection)], "interaction_safety"),
  capability("memory_poisoning", "builtin-memory-poisoning", ["input"], "block", [always("exact", contracts.memoryPoisoning)], "interaction_safety"),
  capability("jailbreak", "builtin-jailbreak", ["input"], "block", [always("primary", contracts.jailbreak, true)], "interaction_safety"),
  capability("system_prompt_leakage", "builtin-system-prompt-leakage", ["output"], "block", [always("exact", contracts.systemPromptLeakage)], "data_protection"),
  capability("content_safety", "builtin-content-safety", ["input", "output"], "block", [always("primary", contracts.contentSafety, true)], "interaction_safety"),
  capability("topic_control", "builtin-topic-safety", ["input"], "block", [always("rules", contracts.topicRules), afterUnknown("semantic", contracts.topicSemantic, "rules")], "business_assurance"),
  capability("contextual_grounding", "builtin-contextual-grounding", ["output"], "block", [always("primary", contracts.contextualGrounding, true)], "business_assurance"),
  capability("automated_reasoning", "builtin-automated-reasoning", ["output"], "block", [always("primary", contracts.automatedReasoning, true)], "business_assurance"),
];

const capabilityByPolicyId = new Map(capabilities.map((item) => [item.policyId, item]));
const capabilityById = new Map(capabilities.map((item) => [item.capability, item]));
const moduleTimeout = { data_protection: 750, interaction_safety: 30_000, business_assurance: 5_000 } as const;

type PlanStep = {
  id: string;
  capability: string;
  contract_ref: string;
  phases: Array<"input" | "output">;
  on_unsafe: EnforcementAction;
  trigger: { type: "always" } | { type: "on_result"; step_ref: string; verdicts: Array<"not_matched" | "matched" | "unknown" | "error"> };
  parameters: Array<[string, string]>;
};

export function normalizeGuardrailDraft(value: unknown): GuardrailDraftConfig {
  const source = record(value);
  if (Array.isArray(source.customContentRules) && source.customContentRules.length) {
    throw new Error("Standalone custom content rules are no longer supported. Configure the Phrase filters Policy before saving or publishing this draft.");
  }
  return {
    ...(typeof record(source.profileOrigin).id === "string" && typeof record(source.profileOrigin).version === "string"
      ? { profileOrigin: { id: String(record(source.profileOrigin).id), version: String(record(source.profileOrigin).version) } } : {}),
    allowedTopics: stringArray(source.allowedTopics),
    restrictedTopics: stringArray(source.restrictedTopics),
    topicControlMode: source.topicControlMode === "permissive" ? "permissive" : "strict",
    policyBindings: Array.isArray(source.policyBindings)
      ? source.policyBindings.map(normalizeBinding)
      : [],
    safetyLevel: source.safetyLevel === "strict" ? "strict" : "balanced",
    outputDelivery: source.outputDelivery === "interruptible" || source.outputDelivery === "window_buffered"
      ? source.outputDelivery
      : "full_buffered",
  };
}

/** Convert the product draft into the immutable contract compiled by Runner. */
export function buildGuardrailPlan(input: {
  guardrailId: string;
  guardrailVersion: string;
  draft: GuardrailDraftConfig;
  policies?: readonly PolicyDto[];
  programmablePolicies?: readonly ProgrammablePolicySnapshot[];
}): Record<string, unknown> {
  const draft = normalizeGuardrailDraft(input.draft);
  const policyById = new Map((input.policies ?? []).flatMap(item => [item, ...(item.published_versions ?? [])]).map(item => [`${item.id}@${item.version}`, item]));
  const programmableByKey = new Map((input.programmablePolicies ?? []).map((item) => [`${item.policy_id}@${item.version}`, item]));
  const bindings = draft.policyBindings;
  const authoredReasoningPolicies: Array<{ id: string; policy_id: string; policy_version: string; confidence_threshold: number }> = [];
  if (!bindings.length) throw new Error("Select at least one Policy before compiling a Guardrail.");

  const resolved: Array<{ capability: RuntimeCapability; binding: GuardrailPolicyBindingConfig; policy?: PolicyDto; authoredRule?: PolicyDto["rules"][number]; authoredParameters?: Array<[string, string]> }> = [];
  const programmable: Array<{ binding: GuardrailPolicyBindingConfig; policy: ProgrammablePolicySnapshot }> = [];
  for (const binding of bindings) {
    const programmablePolicy = programmableByKey.get(`${binding.policyId}@${binding.policyVersion}`);
    if (programmablePolicy) {
      validateProgrammableBinding(binding, programmablePolicy);
      // Normalize into this plan's private binding copy. Required-field checks
      // already accept pinned Policy defaults; the executable payload must carry
      // the same values. Explicit empty strings are values, not missing fields.
      binding.parameterValues = {
        ...Object.fromEntries(programmablePolicy.parameter_schema.flatMap((parameter) =>
          parameter.default == null ? [] : [[parameter.name, parameter.default]])),
        ...binding.parameterValues,
      };
      programmable.push({ binding, policy: programmablePolicy });
      const nativeRisk = Object.fromEntries(programmablePolicy.execution_contract).native_risk;
      const native = nativeRisk ? capabilityById.get(nativeRisk) : undefined;
      if (native) resolved.push({ capability: native, binding });
      continue;
    }
    const catalogPolicy = policyById.get(`${binding.policyId}@${binding.policyVersion}`);
    if (input.policies !== undefined) {
      if (!catalogPolicy) throw new Error(`Policy ${binding.policyId}@${binding.policyVersion} is unavailable in the Controller catalog.`);
      validateCatalogBinding(binding, catalogPolicy);
    }
    if (catalogPolicy?.definition) {
      if (!binding.enabledRails.length) binding.enabledRails = [...catalogPolicy.rails];
      binding.parameterValues = { ...Object.fromEntries(catalogPolicy.parameters.flatMap(p => p.default == null ? [] : [[p.name, p.default]])), ...binding.parameterValues };
      const policy = materializePolicyRules(catalogPolicy, binding);
      policyById.set(`${policy.id}@${policy.version}`, policy);
      const order = [...binding.ruleOrder ?? [], ...policy.rules.map(r => r.id)];
      const ordered = [...policy.rules].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      for (const rule of ordered.filter(r => binding.enabledRuleIds.includes(r.id))) {
        const enabledRails = binding.enabledRails.filter(rail => rule.rails.includes(rail));
        if (!enabledRails.length) continue;
        const scoped = { ...binding, enabledRuleIds: [rule.id], enabledRails };
        const boundaryDetector = ({
          "agent/indirect-injection": ["indirect_prompt_injection", contracts.indirectPromptInjection],
          "agent/memory-poisoning": ["memory_poisoning", "tali.guard.memory-poisoning.v1"],
        } as Record<string, [string, string]>)[rule.detector.ref];
        if (boundaryDetector) {
          resolved.push({ capability: { capability: boundaryDetector[0], policyId: "", defaultPhases: ["input"],
            defaultAction: "block", evaluations: [always("boundary", boundaryDetector[1])], module: "interaction_safety" },
            binding: scoped, authoredRule: rule, authoredParameters: [["rule_id", rule.id]] });
        } else if (rule.implementation.execution === "local") {
          resolved.push({ capability: { capability: "builtin_content_filter", policyId: "", defaultPhases: ["input", "output"], defaultAction: "block", evaluations: [always("rules", contracts.contentFilter)], module: "interaction_safety" }, binding: scoped, policy, authoredRule: rule });
        } else {
          const profile = String(rule.detector_options.profile ?? "");
          const adapter = rule.detector.ref === "model/classifier" ? ({
            "safety-classification": ["content_safety", contracts.contentSafety], "jailbreak-classification": ["jailbreak", contracts.jailbreak],
            "pii-classification": ["pii", contracts.piiSemantic], "topic-classification": ["topic_control", contracts.topicSemantic],
          } as Record<string, [string, string]>)[profile] : rule.detector.ref === "model/grounding" ? ["contextual_grounding", contracts.contextualGrounding] : rule.detector.ref === "service/formal-verification" ? ["automated_reasoning", contracts.automatedReasoning] : undefined;
          if (!adapter) throw new Error(`Detector ${rule.detector.ref} has no executable capability contract.`);
          const authoredRule = catalogPolicy.definition.rules.find(r => r.id === rule.id)!;
          const params = resolveModelRuleParameters(catalogPolicy.definition, authoredRule, binding.parameterValues);
          const authoredParameters: Array<[string, string]> = [["declarative_rule", "true"], ["rule_id", rule.id]];
          for (const key of ["topic_mode", "allowed_topics", "restricted_topics", "grounding_threshold", "relevance_threshold", "policy_snapshot_id", "on_unknown"]) {
            if (params[key] !== undefined) authoredParameters.push([key, String(params[key])]);
          }
          if (rule.detector.ref === "service/formal-verification" && params.policy_id && params.policy_version) {
            const snapshotId = `formal:${JSON.stringify([binding.policyId, binding.policyVersion, rule.id])}`;
            const threshold = Number(params.confidence_threshold ?? 0.8);
            if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error(`Rule ${rule.id}: confidence_threshold must be between 0 and 1.`);
            authoredReasoningPolicies.push({ id: snapshotId, policy_id: String(params.policy_id), policy_version: String(params.policy_version), confidence_threshold: threshold });
            authoredParameters.push(["policy_snapshot_id", snapshotId]);
          } else if (rule.detector.ref === "service/formal-verification" && params.policy_snapshot_id === undefined && binding.reasoningPolicy) {
            authoredParameters.push(["policy_snapshot_id", `automated-reasoning:${binding.reasoningPolicy.policyId}:${binding.reasoningPolicy.policyVersion}`]);
          }
          resolved.push({ capability: { capability: adapter[0]!, policyId: "", defaultPhases: ["input", "output"], defaultAction: rule.effect, evaluations: [always("detector", adapter[1]!, true)], module: "interaction_safety" }, binding: scoped, authoredRule: rule, authoredParameters });
        }
      }
      continue;
    }
    const native = capabilityByPolicyId.get(binding.policyId);
    if (native) {
      // Until platform-native plans are fully Rule-driven, never accept source
      // detector changes that this adapter path would otherwise silently ignore.
      if (catalogPolicy) validateNativeDetectorContract(catalogPolicy, native.capability);
      resolved.push({ capability: native, binding });
      continue;
    }
    let policy = catalogPolicy;
    if (!policy) throw new Error(`Policy ${binding.policyId}@${binding.policyVersion} is unavailable in the Controller catalog.`);
    if (input.policies === undefined) validateCatalogBinding(binding, policy);
    binding.parameterValues = {
      ...Object.fromEntries(policy.parameters.flatMap((parameter) => parameter.default == null ? [] : [[parameter.name, parameter.default]])),
      ...binding.parameterValues,
    };
    policy = materializePolicyRules(policy, binding);
    policyById.set(`${policy.id}@${policy.version}`, policy);
    resolved.push({ capability: {
      capability: "builtin_content_filter", policyId: "", defaultPhases: ["input", "output"],
      defaultAction: "block", evaluations: [always("rules", contracts.contentFilter)], module: "interaction_safety",
    }, binding, policy });
  }

  if (resolved.some(({ capability, binding, authoredRule }) => !authoredRule && !isSplitTopicPolicy(binding.policyId, binding.policyVersion) && capability.capability === "topic_control") && draft.topicControlMode !== "permissive" && !draft.allowedTopics.length) {
    throw new Error("Strict Topic Control requires at least one allowed topic. Unlisted tasks are off-topic.");
  }

  const steps: PlanStep[] = [];
  const modules: Array<Record<string, unknown>> = [];
  const previousModule: Partial<Record<"input" | "output", string>> = {};
  const hasCustomFlows = programmable.some(({ policy }) => policy.source !== "built_in");
  const executable = resolved.flatMap(item => {
    // A custom flow is an ordering barrier for the whole plan, including
    // mixed-action Rules inside an older catalog Policy.
    if (hasCustomFlows || !item.policy || item.authoredRule) return [{ ...item, actionGroup: "" }];
    const actions = new Map<EnforcementAction, string[]>();
    for (const rule of item.policy.rules.filter(r => item.binding.enabledRuleIds.includes(r.id))) {
      const action = item.binding.ruleActions[rule.id] ?? item.binding.action ?? rule.effect as EnforcementAction;
      actions.set(action, [...actions.get(action) ?? [], rule.id]);
    }
    return [...actions].map(([action, ids]) => ({ ...item, actionGroup: actions.size > 1 ? `:${action}` : "",
      binding: { ...item.binding, action, enabledRuleIds: ids, ruleOrder: (item.binding.ruleOrder ?? []).filter(id => ids.includes(id)) } }));
  });
  for (const { capability: definition, binding, policy, authoredRule, authoredParameters, actionGroup } of executable) {
    // Never coalesce separate Policies by capability: a later Policy must see
    // the content produced by every earlier Policy, even across module types.
    const declarative = policy ? [{ binding, policy }] : [];
    const nativePolicy = programmableByKey.get(`${binding.policyId}@${binding.policyVersion}`);
    const catalogNative = !authoredRule && !policy && !nativePolicy ? policyById.get(`${binding.policyId}@${binding.policyVersion}`) : undefined;
    const splitTopic = !authoredRule && isSplitTopicPolicy(binding.policyId, binding.policyVersion);
    // Catalog-native Policies expose one detector Rule. Its local override
    // must change the executable step, not merely the binding audit snapshot.
    // Refuse an ambiguous future catalog shape rather than silently choosing
    // one of several Rules for the same detector.
    if (catalogNative && catalogNative.rules.length !== 1 && !splitTopic) {
      throw new Error(`Native Policy ${binding.policyId} must declare exactly one detector Rule.`);
    }
    const catalogRule = authoredRule ?? (splitTopic ? undefined : catalogNative?.rules[0]);
    const phases = phasesFor(definition, binding, declarative).filter((phase) => !nativePolicy || nativePolicy.rail_bindings.some((rail) => (
      rail.rail_type === phase && binding.enabledRuleIds.includes(flowRuleId(phase, rail.flow_name))
    ))).filter((phase) => !catalogRule || (binding.enabledRuleIds.includes(catalogRule.id) && catalogRule.rails.includes(phase)));
    const parameters: Array<[string, string]> = [
      ["policy_id", binding.policyId],
      ["policy_version", binding.policyVersion],
      ...(authoredParameters ?? parametersFor(definition.capability, binding, draft, declarative)),
    ];
    const suffix = authoredRule ? `:${authoredRule.id}` : actionGroup;
    const prefix = `${definition.capability}:${binding.policyId}${suffix}`;
    const policySteps: PlanStep[] = [];
    const values = topicPolicyValues(binding.parameterValues);
    // Deny-first is the Policy's semantic contract, independent of display order.
    const groups: Array<{ prefix: string; phases: Array<"input" | "output">; action: EnforcementAction; parameters?: Array<[string, string]> }> = splitTopic ? [TOPIC_DENY_RULE, TOPIC_ALLOW_RULE].filter(id => binding.enabledRuleIds.includes(id)).map(id => ({
      prefix: `${prefix}:${id}`, phases,
      action: id === TOPIC_DENY_RULE ? "block" as EnforcementAction : binding.ruleActions[id] ?? binding.action ?? "block" as EnforcementAction,
      parameters: [["policy_id", binding.policyId], ["policy_version", binding.policyVersion], ["rule_id", id],
        ["topic_mode", id === TOPIC_DENY_RULE ? "permissive" : values.mode],
        ["allowed_topics", id === TOPIC_ALLOW_RULE ? values.allowed : ""],
        ["restricted_topics", id === TOPIC_DENY_RULE ? values.denied : ""]] as Array<[string, string]>,
    })) : nativePolicy ? phases.map((phase) => {
      const rail = nativePolicy.rail_bindings.find((item) => item.rail_type === phase && binding.enabledRuleIds.includes(flowRuleId(phase, item.flow_name)))!;
      return {
        prefix: `${prefix}:${phase}`, phases: [phase],
        action: binding.ruleActions[flowRuleId(phase, rail.flow_name)] ?? binding.action ?? rail.on_unsafe,
      };
    }) : [{ prefix, phases, action: (catalogRule ? binding.ruleActions[catalogRule.id] : undefined)
      ?? binding.action ?? (catalogRule?.effect as EnforcementAction | undefined) ?? definition.defaultAction }];
    const evaluations = splitTopic ? [always("semantic", contracts.topicSemantic, true)] : definition.evaluations;
    for (const group of groups) for (const evaluation of evaluations) {
      policySteps.push({
        id: `${group.prefix}:${evaluation.idSuffix}`,
        capability: definition.capability,
        contract_ref: evaluation.contractRef,
        phases: group.phases,
        on_unsafe: group.action,
        trigger: evaluation.after
          ? {
              type: "on_result",
              step_ref: `${group.prefix}:${evaluation.after.idSuffix}`,
              verdicts: draft.safetyLevel === "strict"
                ? Array.from(new Set(["not_matched" as const, ...evaluation.after.verdicts]))
                : evaluation.after.verdicts,
            }
          : { type: "always" },
        parameters: group.parameters ?? parameters,
      });
    }
    steps.push(...policySteps);
    for (const phase of phases) {
      const id = `${definition.module}:${binding.policyId}${suffix}:${phase}`;
      modules.push({
        id, module: definition.module, phase, step_ids: policySteps.filter((step) => step.phases.includes(phase)).map((step) => step.id),
        depends_on: previousModule[phase] ? [previousModule[phase]] : [], input_view: "previous_output",
        required_for_release: true,
        timeout_ms: definition.evaluations.some((evaluation) => evaluation.potentiallyRemote) ? 30_000 : moduleTimeout[definition.module],
        failure_mode: "fail_closed",
      });
      previousModule[phase] = id;
    }
  }
  // Compilation may reorder execution for latency, but it must not change what a
  // check inspects. Record the authored precedence (reporting and evidence
  // arbitration never infer "earlier" from execution order) and the declared
  // evaluation view of each step: a read-only check inspects the phase input,
  // while a mutating step and every step of its trigger chain inspect the text
  // produced by the preceding Transform steps.
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const authoredIndex = new Map(steps.map((step, index) => [step.id, index]));
  const inheritsMutation = (step: PlanStep, seen = new Set<string>()): boolean => {
    if (step.on_unsafe === "transform") return true;
    const prerequisite = step.trigger.type === "on_result" ? step.trigger.step_ref : undefined;
    if (prerequisite === undefined || seen.has(prerequisite)) return false;
    seen.add(prerequisite);
    const source = stepById.get(prerequisite);
    return source !== undefined && inheritsMutation(source, seen);
  };
  for (const step of steps) {
    step.parameters = [...step.parameters,
      ["precedence", String(authoredIndex.get(step.id)!)],
      ["evaluation_view", hasCustomFlows || inheritsMutation(step) ? "previous_output" : "original"],
    ];
  }
  scheduleChecks(steps, modules, hasCustomFlows, draft.outputDelivery === "full_buffered");
  const reasoningPolicies = bindings.flatMap((binding) => binding.reasoningPolicy ? [{
    id: `automated-reasoning:${binding.reasoningPolicy.policyId}:${binding.reasoningPolicy.policyVersion}`,
    policy_id: binding.reasoningPolicy.policyId,
    policy_version: binding.reasoningPolicy.policyVersion,
    confidence_threshold: binding.reasoningPolicy.confidenceThreshold,
  }] : []);
  return {
    guardrail_id: input.guardrailId,
    guardrail_version: input.guardrailVersion,
    compiler_version: EXPLICIT_VIEWS_PLAN_VERSION,
    topic_control_mode: draft.topicControlMode ?? "strict",
    safety_level: draft.safetyLevel,
    output_delivery: draft.outputDelivery,
    steps,
    modules,
    reasoning_policies: [...reasoningPolicies, ...authoredReasoningPolicies],
    policy_versions: programmable.map(({ policy }) => planPolicyVersion(policy)),
    policy_bindings: bindings.map((binding) => ({
      policy_id: binding.policyId,
      policy_version: binding.policyVersion,
      action: binding.action,
      parameter_values: Object.entries(binding.parameterValues).sort(([left], [right]) => left.localeCompare(right)),
      enabled_rule_ids: binding.enabledRuleIds,
      rule_order: binding.ruleOrder ?? [],
      rule_actions: Object.entries(binding.ruleActions).sort(([left], [right]) => left.localeCompare(right)),
      // Compiler-owned snapshot; no Guardrail risk override is accepted.
      rule_severities: (programmableByKey.get(`${binding.policyId}@${binding.policyVersion}`)?.rail_bindings.map(rail => ({ id: flowRuleId(rail.rail_type, rail.flow_name), risk_severity: rail.risk_severity }))
        ?? policyById.get(`${binding.policyId}@${binding.policyVersion}`)?.rules
        ?? []).filter(rule => binding.enabledRuleIds.includes(rule.id) && rule.risk_severity)
        .map(rule => [rule.id, rule.risk_severity]),
      enabled_rails: binding.enabledRails,
    })),
  };
}

function validateNativeDetectorContract(policy: PolicyDto, capability: string): void {
  const profiles: Record<string, string> = {
    topic_control: "topic-classification",
    content_safety: "safety-classification", jailbreak: "jailbreak-classification", pii: "pii-classification",
  };
  for (const rule of policy.rules) {
    const boundaryRef = capability === "indirect_prompt_injection" ? "agent/indirect-injection"
      : capability === "memory_poisoning" ? "agent/memory-poisoning" : null;
    if (boundaryRef && (rule.detector.ref !== boundaryRef || rule.implementation.execution !== "local")) {
      throw new Error(`Policy ${policy.id} requires detector ${boundaryRef}.`);
    }
    if (rule.implementation.execution !== "platform") continue;
    const expected = profiles[capability];
    if (expected && (rule.detector.ref !== "model/classifier" || rule.detector_options.profile !== expected)) {
      throw new Error(`Policy ${policy.id} requires the ${expected} detector contract.`);
    }
    const ref = capability === "contextual_grounding" ? "model/grounding"
      : capability === "automated_reasoning" ? "service/formal-verification" : null;
    if (ref && rule.detector.ref !== ref) throw new Error(`Policy ${policy.id} requires detector ${ref}.`);
  }
}

function parametersFor(
  capabilityId: string,
  binding: GuardrailPolicyBindingConfig,
  draft: GuardrailDraftConfig,
  declarative: Array<{ binding: GuardrailPolicyBindingConfig; policy: PolicyDto }>,
): Array<[string, string]> {
  if (capabilityId === "builtin_content_filter") {
    return [
      ["policy_versions_json", JSON.stringify(Object.fromEntries(declarative.map((item) => [item.binding.policyId, item.policy.version])))],
      // A published Guardrail owns its Rule definitions. Catalog changes or
      // custom package replacement must not mutate an already compiled plan.
      ["policy_definitions_json", JSON.stringify(Object.fromEntries(declarative.map(({ policy }) => [policy.id, frozenBuiltInDefinition(policy)])))],
      ["policy_ids", declarative.map((item) => item.binding.policyId).join("\n")],
      ["enabled_rules_json", JSON.stringify(Object.fromEntries(declarative.map((item) => [item.binding.policyId, item.binding.enabledRuleIds])))],
      ["rule_order_json", JSON.stringify(Object.fromEntries(declarative.map((item) => [item.binding.policyId, item.binding.ruleOrder ?? []])))],
      // Resolve action inheritance per Rule, without modifying the library or
      // replacing the authored Policy/Rule overrides in policy_bindings.
      ["rule_actions_json", JSON.stringify(Object.fromEntries(declarative.map(({ binding: item, policy }) => [
        item.policyId,
        Object.fromEntries(policy.rules.filter((rule) => item.enabledRuleIds.includes(rule.id))
          .map((rule) => [
          rule.id, item.ruleActions[rule.id] ?? item.action ?? rule.effect,
        ])),
      ])))],
      ["policy_parameters_json", JSON.stringify(Object.fromEntries(declarative.filter((item) => Object.keys(item.binding.parameterValues).length).map((item) => [item.binding.policyId, item.binding.parameterValues])))],
    ];
  }
  if (capabilityId === "topic_control") {
    return [
      ["topic_mode", draft.topicControlMode ?? "strict"],
      ["allowed_topics", draft.allowedTopics.join("\n")],
      ["restricted_topics", draft.restrictedTopics.join("\n")],
    ];
  }
  if (capabilityId === "contextual_grounding") {
    return [["grounding_threshold", binding.parameterValues.grounding_threshold ?? "0.7"], ["relevance_threshold", binding.parameterValues.relevance_threshold ?? "0.7"]];
  }
  if (capabilityId === "automated_reasoning" && binding.reasoningPolicy) {
    return [["policy_snapshot_id", `automated-reasoning:${binding.reasoningPolicy.policyId}:${binding.reasoningPolicy.policyVersion}`]];
  }
  return [];
}

function phasesFor(
  capability: RuntimeCapability,
  binding: GuardrailPolicyBindingConfig,
  declarative: Array<{ binding: GuardrailPolicyBindingConfig; policy: PolicyDto }>,
): Array<"input" | "output"> {
  if (capability.capability === "builtin_content_filter") {
    const selected = new Set(declarative.flatMap(({ binding: item, policy }) => {
      const enabled = item.enabledRails.length ? item.enabledRails : policy.rails;
      return policy.rails.filter((phase) => enabled.includes(phase));
    }));
    return (["input", "output"] as const).filter((phase) => selected.has(phase));
  }
  const enabled = binding.enabledRails.filter((item): item is "input" | "output" => item === "input" || item === "output");
  return enabled.length ? capability.defaultPhases.filter((phase) => enabled.includes(phase)) : capability.defaultPhases;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validateCatalogBinding(binding: GuardrailPolicyBindingConfig, policy: PolicyDto): void {
  if (!policy.definition && isSplitTopicPolicy(binding.policyId, binding.policyVersion)) {
    const missing = topicMissingParameters(binding.parameterValues, binding.enabledRuleIds);
    if (missing.length) throw new Error(`Topic Control requires configuration for enabled Rules: ${missing.join(", ")}.`);
    if (binding.parameterValues.topic_mode && !["strict", "permissive"].includes(binding.parameterValues.topic_mode)) throw new Error("Topic Control Allowlist mode must be strict or permissive.");
    if (binding.ruleActions[TOPIC_DENY_RULE] && binding.ruleActions[TOPIC_DENY_RULE] !== "block") throw new Error("The Topic Control Denylist Rule must reject denied tasks.");
  }
  if (!policy.definition && policy.id === PHRASE_POLICY_ID) parsePhraseEntries(binding.parameterValues[PHRASE_PARAMETER] ?? "");
  if (binding.policyVersion !== policy.version) throw new Error(`Policy ${policy.id} must pin catalog version ${policy.version}; received ${binding.policyVersion}.`);
  const enabledRails = binding.enabledRails.length ? binding.enabledRails : policy.rails;
  if (enabledRails.some((rail) => !policy.rails.includes(rail) || !["input", "output"].includes(rail))) {
    throw new Error(`Policy ${policy.id} enables an unsupported Rail. Supported: ${policy.rails.join(", ")}.`);
  }
  if (!policy.rules.some((rule) => binding.enabledRuleIds.includes(rule.id) && rule.rails.some((rail) => enabledRails.includes(rail)))) {
    throw new Error(`Policy ${policy.id} has no enabled Rules in its enabled Rails.`);
  }
  const ruleIds = new Set(policy.rules.map((item) => item.id));
  validateRuleOrder(binding, ruleIds);
  const unknownRules = binding.enabledRuleIds.filter((item) => !ruleIds.has(item));
  if (unknownRules.length) throw new Error(`Policy ${policy.id} contains unknown enabled Rules: ${unknownRules.join(", ")}.`);
  if (!binding.enabledRuleIds.length) throw new Error(`Policy ${policy.id} must enable at least one Rule.`);
  if (policy.definition) {
    const issues = policyBindingParameterIssues(policy.definition, binding.parameterValues, binding.enabledRuleIds, binding.enabledRails, binding.reasoningPolicy);
    if (issues.length) throw new Error(`Policy ${policy.id}: ${issues.join(" ")}`);
  }
  for (const parameter of policy.definition ? activePolicyParameters(policy.definition, binding.enabledRuleIds, binding.enabledRails) : policy.parameters) {
    if (parameter.required && !(binding.parameterValues[parameter.name] ?? parameter.default ?? "").trim()) {
      throw new Error(`Policy ${policy.id} requires parameter ${parameter.name}.`);
    }
  }
}

function validateProgrammableBinding(binding: GuardrailPolicyBindingConfig, policy: ProgrammablePolicySnapshot): void {
  const ruleIds = new Set(policy.rail_bindings.map((item) => flowRuleId(item.rail_type, item.flow_name)));
  validateRuleOrder(binding, ruleIds);
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

function normalizeBinding(value: unknown): GuardrailPolicyBindingConfig {
  const source = record(value);
  const reasoning = record(source.reasoningPolicy);
  return {
    policyId: string(source.policyId),
    policyVersion: string(source.policyVersion),
    action: enforcementActions.includes(source.action as EnforcementAction) ? source.action as EnforcementAction : null,
    parameterValues: stringRecord(source.parameterValues),
    enabledRuleIds: stringArray(source.enabledRuleIds),
    ruleOrder: stringArray(source.ruleOrder),
    testCaseOverrides: expectationOverrides(source.testCaseOverrides),
    ruleActions: actionRecord(source.ruleActions),
    enabledRails: stringArray(source.enabledRails).filter((item): item is GuardrailRail => ["input", "output", "retrieval", "dialog", "execution"].includes(item)),
    reasoningPolicy: reasoning.policyId && reasoning.policyVersion ? {
      policyId: string(reasoning.policyId), policyVersion: string(reasoning.policyVersion),
      confidenceThreshold: finite(reasoning.confidenceThreshold, 0.8),
    } : null,
  };
}

function validateRuleOrder(binding: GuardrailPolicyBindingConfig, ruleIds: Set<string>): void {
  const order = binding.ruleOrder ?? [];
  if (new Set(order).size !== order.length) throw new Error(`Policy ${binding.policyId} contains duplicate Rules in ruleOrder.`);
  const unknown = order.filter((id) => !ruleIds.has(id));
  if (unknown.length) throw new Error(`Policy ${binding.policyId} contains unknown ordered Rules: ${unknown.join(", ")}.`);
  const unknownOverrides = Object.keys(binding.ruleActions).filter((id) => !ruleIds.has(id));
  if (unknownOverrides.length) throw new Error(`Policy ${binding.policyId} contains unknown Rule action overrides: ${unknownOverrides.join(", ")}.`);
}

function expectationOverrides(value: unknown): Record<string, ValidationExpectationOverride> {
  return Object.fromEntries(Object.entries(record(value)).map(([id, raw]) => {
    const item = record(raw);
    const matches = Array.isArray(item.expectedMatches) ? item.expectedMatches.map(record) : [];
    if (!string(item.reason).trim() || !string(item.sourcePolicyVersion)
      || !["allow", "block", "transform", "intervene"].includes(string(item.expectedDecision))
      || matches.some((match) => !string(match.policyId) || !string(match.ruleId))
      || (item.expectedDecision !== "allow" && !matches.length)
      || (item.expectedOutputContent !== undefined && typeof item.expectedOutputContent !== "string")) {
      throw new Error(`Invalid reviewed expectation override for Test Case ${id}.`);
    }
    return [id, {
      sourcePolicyVersion: string(item.sourcePolicyVersion), reason: string(item.reason).trim(),
      expectedDecision: item.expectedDecision as ValidationExpectationOverride["expectedDecision"],
      ...(typeof item.expectedOutputContent === "string" ? { expectedOutputContent: item.expectedOutputContent } : {}),
      expectedMatches: matches.map((match) => ({ policyId: string(match.policyId), ruleId: string(match.ruleId) })),
    }];
  }));
}

function capability(
  capabilityId: string, policyId: string, defaultPhases: Array<"input" | "output">,
  defaultAction: EnforcementAction, evaluations: RuntimeEvaluation[], module: RuntimeCapability["module"],
): RuntimeCapability { return { capability: capabilityId, policyId, defaultPhases, defaultAction, evaluations, module }; }

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function stringRecord(value: unknown): Record<string, string> { return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string")); }
function actionRecord(value: unknown): Record<string, EnforcementAction> { return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, EnforcementAction] => enforcementActions.includes(entry[1] as EnforcementAction))); }
function finite(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
