import type { DefinitionRule, PolicyDefinition } from "./policy-definition.js";

const referencePattern = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
export const parameterNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const parameterReference = (name: string) => `{{${name}}}`;
export function parameterReferences(value: unknown): string[] {
  return typeof value === "string" ? [...value.matchAll(referencePattern)].map(match => match[1]!) : [];
}
export function parameterReferenceName(value: unknown): string | null {
  return typeof value === "string" && /^\{\{[A-Za-z_][A-Za-z0-9_]*\}\}$/.test(value) ? value.slice(2, -2) : null;
}

export type ModelParameterField = { key: string; name: string; kind: "text" | "textarea" | "number"; default: string | null; required: boolean };
export function modelParameterFields(rule: DefinitionRule): ModelParameterField[] {
  if (rule.detector.ref === "model/classifier" && rule.detector.parameters.profile === "topic-classification") return [
    { key: "topic_mode", name: "topic_mode", kind: "text", default: "permissive", required: true },
    { key: "allowed_topics", name: "allowed_topics", kind: "textarea", default: null, required: false },
    { key: "restricted_topics", name: "denied_topics", kind: "textarea", default: null, required: false },
    { key: "on_unknown", name: "on_unknown", kind: "text", default: "block", required: false },
  ];
  if (rule.detector.ref === "model/classifier" && ["jailbreak-classification", "safety-classification"].includes(String(rule.detector.parameters.profile))) return [
    { key: "on_unknown", name: "on_unknown", kind: "text", default: "block", required: false },
  ];
  if (rule.detector.ref === "model/grounding") return ["grounding_threshold", "relevance_threshold"].map(key => ({ key, name: key, kind: "number", default: "0.7", required: true }));
  if (rule.detector.ref === "service/formal-verification") return [
    { key: "policy_id", name: "formal_policy_id", kind: "text", default: null, required: true },
    { key: "policy_version", name: "formal_policy_version", kind: "text", default: null, required: true },
    { key: "confidence_threshold", name: "confidence_threshold", kind: "number", default: "0.8", required: true },
  ];
  return [];
}

/** Structural checks run while authoring; values are supplied by each Guardrail. */
export function modelParameterDeclarationIssues(definition: PolicyDefinition): string[] {
  const issues: string[] = [];
  if (new Set(definition.parameters.map(p => p.name)).size !== definition.parameters.length) issues.push("Parameter names must be unique.");
  for (const parameter of definition.parameters) if (!parameterNamePattern.test(parameter.name)) issues.push(`Parameter ${parameter.name}: use letters, numbers and underscores, starting with a letter or underscore.`);
  for (const rule of definition.rules) {
    if (!rule.detector.ref.startsWith("model/") && !rule.detector.ref.startsWith("service/")) continue;
    const fields = modelParameterFields(rule);
    if (rule.detector.parameters.on_unknown !== undefined) {
      const value = rule.detector.parameters.on_unknown;
      if (!fields.some(field => field.key === "on_unknown")) issues.push(`Rule ${rule.name || rule.id}: on_unknown is supported only by the jailbreak, content safety and topic classifiers.`);
      else if (!parameterReferences(value).length && !["allow", "block"].includes(String(value))) issues.push(`Rule ${rule.name || rule.id}: on_unknown must be allow or block.`);
    }
    for (const [key, value] of Object.entries(rule.detector.parameters)) {
      if (typeof value !== "string") continue;
      const refs = parameterReferences(value);
      if (/\{\{|\}\}/.test(value.replace(referencePattern, ""))) issues.push(`Rule ${rule.name || rule.id}: invalid parameter reference in ${key}. Use {{parameter_name}}.`);
      for (const name of refs) {
        const declared = definition.parameters.find(p => p.name === name);
        const field = fields.find(f => f.key === key);
        if (!field) issues.push(`Rule ${rule.name || rule.id}: ${key} cannot reference a Guardrail parameter.`);
        if (!declared) issues.push(`Rule ${rule.name || rule.id}: parameter ${name} is not declared.`);
        else if (declared.kind === "secret") issues.push(`Rule ${rule.name || rule.id}: model configuration cannot reference secret parameter ${name}.`);
        else if (field && (field.kind === "number" ? declared.kind !== "number" : !["text", "textarea"].includes(declared.kind))) issues.push(`Rule ${rule.name || rule.id}: parameter ${name} has an incompatible type for ${key}.`);
        if (field?.kind === "number" && !parameterReferenceName(value)) issues.push(`Rule ${rule.name || rule.id}: ${key} requires a single number parameter reference.`);
      }
    }
  }
  return issues;
}

export function policyParameterValues(definition: PolicyDefinition, values: Record<string, string>): Record<string, string> {
  return { ...Object.fromEntries(definition.parameters.flatMap(p => p.default == null ? [] : [[p.name, p.default]])), ...values };
}

/** Parameters used only by disabled model Rules do not block an active binding. */
export function activePolicyParameters(definition: PolicyDefinition, enabledRuleIds: readonly string[], rails?: readonly string[]) {
  const all = new Set(definition.rules.flatMap(r => modelParameterFields(r).flatMap(f => parameterReferences(r.detector.parameters[f.key]))));
  const active = new Set(definition.rules.filter(r => enabledRuleIds.includes(r.id) && (!rails?.length || r.stages.some(s => rails.includes(s))))
    .flatMap(r => modelParameterFields(r).flatMap(f => parameterReferences(r.detector.parameters[f.key]))));
  return definition.parameters.filter(p => !all.has(p.name) || active.has(p.name));
}

export function resolveModelRuleParameters(definition: PolicyDefinition, rule: DefinitionRule, values: Record<string, string>): Record<string, unknown> {
  const resolved = { ...rule.detector.parameters };
  const parameters = policyParameterValues(definition, values);
  for (const field of modelParameterFields(rule)) {
    const value = resolved[field.key];
    if (typeof value !== "string") continue;
    resolved[field.key] = value.replace(referencePattern, (_, name: string) => {
      if (!definition.parameters.some(p => p.name === name)) throw new Error(`Rule ${rule.name || rule.id}: parameter ${name} is not declared.`);
      return parameters[name] ?? "";
    });
  }
  return resolved;
}

/** Shared by the Guardrail editor, test runs and executable-plan compilation. */
export function policyBindingParameterIssues(definition: PolicyDefinition, values: Record<string, string>, enabledRuleIds: readonly string[], rails?: readonly string[], formalPolicy?: { policyId: string; policyVersion: string } | null): string[] {
  const issues = modelParameterDeclarationIssues(definition);
  const parameters = policyParameterValues(definition, values);
  for (const parameter of activePolicyParameters(definition, enabledRuleIds, rails)) {
    const value = parameters[parameter.name] ?? "";
    if (parameter.required && !value.trim()) issues.push(`Provide ${parameter.label || parameter.name}.`);
    if (parameter.kind === "number" && value.trim() && !Number.isFinite(Number(value))) issues.push(`${parameter.label || parameter.name} must be a number.`);
  }
  for (const rule of definition.rules.filter(r => enabledRuleIds.includes(r.id) && (!rails?.length || r.stages.some(s => rails.includes(s))))) {
    if (!modelParameterFields(rule).length) continue;
    let params: Record<string, unknown>;
    try { params = resolveModelRuleParameters(definition, rule, values); } catch (error) { issues.push(String(error)); continue; }
    for (const field of modelParameterFields(rule)) {
      const value = params[field.key] ?? field.default;
      if (field.kind === "number" && (value == null || !String(value).trim() || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1)) issues.push(`Rule ${rule.name || rule.id}: ${field.key} must be between 0 and 1.`);
    }
    if (modelParameterFields(rule).some(field => field.key === "on_unknown") && !["allow", "block"].includes(String(params.on_unknown ?? "block"))) {
      issues.push(`Rule ${rule.name || rule.id}: on_unknown must be allow or block.`);
    }
    if (rule.detector.parameters.profile === "topic-classification") {
      const mode = params.topic_mode ?? "permissive";
      if (!["strict", "permissive"].includes(String(mode))) issues.push(`Rule ${rule.name || rule.id}: topic_mode must be strict or permissive.`);
      if (mode === "strict" && !String(params.allowed_topics ?? "").trim()) issues.push(`Rule ${rule.name || rule.id}: strict mode requires allowed topics.`);
    }
    if (rule.detector.ref === "service/formal-verification" && params.policy_snapshot_id === undefined) {
      // Native formal Rules keep their existing versioned Guardrail binding contract.
      const fallback = params.policy_id === undefined && params.policy_version === undefined ? formalPolicy : null;
      const reference = { policy_id: params.policy_id ?? fallback?.policyId, policy_version: params.policy_version ?? fallback?.policyVersion };
      for (const key of ["policy_id", "policy_version"] as const) if (!String(reference[key] ?? "").trim()) issues.push(`Rule ${rule.name || rule.id}: provide ${key}.`);
    }
  }
  return [...new Set(issues)];
}
