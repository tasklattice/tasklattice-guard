import { z } from "zod";
import { modelParameterDeclarationIssues, parameterReferences } from "./policy-parameters.js";
import { patternValidatorSchema } from "./pattern-validator.js";
import { riskSeverities } from "./security-severity.js";

export const detectorRefs = ["text/keyword", "text/regex", "text/conditions", "code/fenced-block", "agent/indirect-injection", "agent/memory-poisoning", "model/classifier", "model/grounding", "service/formal-verification"] as const;
export const localDetectorRefs = detectorRefs.slice(0, 6);
const phase = z.enum(["input", "output"]);
const action = z.enum(["allow", "block", "transform"]);
const text = z.string().max(500_000);
const identifier = z.string().min(1).max(256);
export const policyTestContextSchema = z.object({ target_source: z.enum(["user_input", "retrieved_content", "tool_output", "model_output"]).nullable().optional(), trusted_instruction: text.default(""), query: text.default(""), grounding_sources: z.array(text).default([]), expected_reasoning_result: z.string().nullable().default(null) });
const tag = z.object({ namespace: z.string(), value: z.string(), label: z.string(), source: z.enum(["declared", "derived"]).default("declared") });

/** Portable authoring data. Environment permissions and engine identities never travel here. */
export const policyDefinitionSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("Policy"),
  metadata: z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).max(160),
    name: z.string().trim().min(1).max(160), description: z.string().max(2000).default(""),
    version: z.string().min(1).max(100), tags: z.array(tag).max(64),
    safety_level: z.enum(["balanced", "strict"]).default("balanced"),
    output_delivery: z.enum(["interruptible", "window_buffered", "full_buffered"]).default("full_buffered"),
  }).strict(),
  parameters: z.array(z.object({ name: identifier, label: z.string().default(""), kind: z.string(), required: z.boolean(), placeholder: z.string().default(""), description: z.string().default(""), default: z.string().nullable().default(null) })).max(128).default([]),
  rules: z.array(z.object({
    id: identifier, name: z.string().max(160), description: z.string().max(2000).default(""),
    stages: z.array(phase).max(2),
    detector: z.object({ ref: z.enum(detectorRefs), version: z.literal("1.0.0"), parameters: z.record(z.string(), z.unknown()).default({}) }).strict(),
    on_match: z.object({ action, replacement: z.string().nullable().optional() }).strict(),
    risk_level: z.enum(riskSeverities),
    metadata: z.object({ taxonomy_ids: z.array(z.string().regex(/^TALI(?:-[A-Z0-9]+)+$/)).min(1) }).strict(),
    expand: z.object({ parameter: identifier, text_field: identifier, action_field: identifier, replacement_field: identifier }).nullable().optional(),
  }).strict()).max(512),
  tests: z.array(z.object({
    id: identifier, name: z.string().max(160), description: z.string().max(2000).default(""),
    phase, content: text, expected_decision: z.enum(["allow", "block", "transform", "intervene"]),
    covered_rule_ids: z.array(identifier).max(512),
    kind: z.enum(["rule_acceptance", "scenario"]).default("rule_acceptance"),
    scope: z.enum(["rule", "policy"]).default("rule"), required: z.boolean().default(true),
    parameter_names: z.array(identifier).default([]), group: z.string().default("Policy tests"),
    expected_text: text.nullable().optional(), expected_matched_rules: z.array(identifier).nullable().optional(),
    context: policyTestContextSchema.optional(),
  }).strict()).max(5000),
  testing: z.object({ parameters: z.record(z.string(), z.string()).default({}) }).optional(),
  execution: z.object({ mode: z.literal("sequential"), input: z.literal("previous_output"), stop_on: z.literal("block") }).default({ mode: "sequential", input: "previous_output", stop_on: "block" }),
}).strict();
export type PolicyDefinition = z.infer<typeof policyDefinitionSchema>;
export type DefinitionRule = PolicyDefinition["rules"][number];
export type DefinitionTest = PolicyDefinition["tests"][number];
export type PolicyResource = { id: string; definition: PolicyDefinition; revision: number; maintainer: string; published_version: string | null; validation?: ResourceValidation | null };
export type PolicyTestAssessment = { caseId: string; name: string; passed: boolean; reason: string; actualDecision: string; outputContent: string; matchedRuleIds: string[]; modelInvocations?: number; actualReasoningResult?: string | null; findings?: Array<Record<string, unknown>> };
export type ResourceValidation = { id: string; policyId: string; revision: number; status: string; total: number; passed: number; failureReason: string | null };

export function definitionIssues(definition: PolicyDefinition): string[] {
  const issues: string[] = modelParameterDeclarationIssues(definition);
  const add = (condition: boolean, message: string) => { if (condition) issues.push(message); };
  add(!definition.rules.length, "Add at least one Rule.");
  add(new Set(definition.rules.map(r => r.id)).size !== definition.rules.length, "Rule IDs must be unique.");
  add(new Set(definition.tests.map(t => t.id)).size !== definition.tests.length, "Test Case IDs must be unique.");
  add(new Set(definition.parameters.map(p => p.name)).size !== definition.parameters.length, "Parameter names must be unique.");
  add(definition.parameters.some(p => p.kind === "secret" && p.default !== null), "Secret parameters cannot contain default values.");
  add(Object.keys(definition.testing?.parameters ?? {}).some(name => !definition.parameters.some(p => p.name === name && p.kind !== "secret")), "Test parameters must reference declared, non-secret parameters.");
  const rules = new Map(definition.rules.map(r => [r.id, r]));
  for (const rule of definition.rules) {
    add(!rule.name.trim() || !rule.stages.length || new Set(rule.stages).size !== rule.stages.length, `Rule ${rule.id}: provide a name and unique stages.`);
    for (const stage of rule.stages) add(!definition.tests.some(t => t.required && t.kind === "rule_acceptance" && t.scope === "rule" && t.phase === stage && t.covered_rule_ids.includes(rule.id)), `Rule ${rule.name || rule.id}: add a required ${stage} Rule acceptance test.`);
    const params = rule.detector.parameters;
    if (rule.detector.ref.startsWith("agent/")) {
      add(rule.stages.some(stage => stage !== "input"), `Rule ${rule.id}: agent boundary checks only support input.`);
      add(Object.keys(params).length > 0, `Rule ${rule.id}: this Detector has no configurable parameters.`);
    }
    if (["model/grounding", "service/formal-verification"].includes(rule.detector.ref)) {
      add(rule.stages.some(stage => stage !== "output"), `Rule ${rule.id}: this Detector only supports output.`);
    }
    if (rule.detector.ref === "model/grounding") {
      for (const key of ["grounding_threshold", "relevance_threshold"]) {
        add(!parameterReferences(params[key]).length && !validThreshold(params[key] ?? 0.7), `Rule ${rule.id}: ${key} must be between 0 and 1.`);
      }
    }
    if (rule.detector.ref === "service/formal-verification") {
      add(typeof params.policy_id !== "string" || !params.policy_id.trim() || typeof params.policy_version !== "string" || !params.policy_version.trim(), `Rule ${rule.id}: provide a formal policy ID and version.`);
      add(!parameterReferences(params.confidence_threshold).length && !validThreshold(params.confidence_threshold ?? 0.8), `Rule ${rule.id}: confidence_threshold must be between 0 and 1.`);
    }
    if (rule.detector.ref === "text/regex") {
      add(typeof params.expression !== "string" || !params.expression.trim(), `Rule ${rule.id}: enter a regular expression.`);
      if (params.validators !== undefined) add(!z.array(patternValidatorSchema).safeParse(params.validators).success, `Rule ${rule.id}: invalid candidate validators.`);
    }
    if (rule.detector.ref === "text/keyword") {
      const options = params.detector_options as { terms?: unknown } | undefined;
      const terms = options?.terms;
      const hasTerms = Array.isArray(terms) ? terms.some(t => typeof t === "string" && t.trim()) : typeof terms === "string" ? Boolean(terms.trim()) : Boolean(terms && typeof terms === "object" && "parameter" in terms);
      add(!rule.expand && !(Array.isArray(params.keywords) && params.keywords.length) && !hasTerms, `Rule ${rule.id}: add matching words or phrases.`);
    }
    if (rule.detector.ref === "text/conditions") add(!(params.detector_options as { match?: unknown } | undefined)?.match, `Rule ${rule.id}: add a matching condition.`);
    if (rule.on_match.action === "transform" && localDetectorRefs.includes(rule.detector.ref)) {
      add(rule.on_match.replacement == null, `Rule ${rule.id}: enter replacement text.`);
      add(!["text/keyword", "text/regex"].includes(rule.detector.ref), `Rule ${rule.id}: this detector does not support replacement.`);
    }
  }
  for (const test of definition.tests) {
    const evaluatedRules = test.scope === "rule" ? test.covered_rule_ids.map(id => rules.get(id)).filter(Boolean) : definition.rules.filter(rule => rule.stages.includes(test.phase));
    if (evaluatedRules.some(rule => ["model/grounding", "service/formal-verification"].includes(rule!.detector.ref))) add(!test.context?.query.trim(), `Test ${test.name || test.id}: provide a user query.`);
    if (evaluatedRules.some(rule => rule!.detector.ref === "model/grounding")) add(!test.context?.grounding_sources.some(source => source.trim()), `Test ${test.name || test.id}: provide at least one grounding source.`);
    if (evaluatedRules.some(rule => rule!.detector.ref === "service/formal-verification")) add(!["valid", "invalid", "satisfiable", "impossible", "translation_ambiguous", "too_complex", "no_translations"].includes(test.context?.expected_reasoning_result ?? ""), `Test ${test.name || test.id}: select an expected reasoning result.`);
    add(!test.name.trim() || !test.content, `Test ${test.name || test.id}: provide a name and input text.`);
    add(test.scope === "rule" && test.covered_rule_ids.length !== 1, `Test ${test.name || test.id}: a Rule test must select exactly one Rule.`);
    add(test.covered_rule_ids.some(id => !rules.get(id)?.stages.includes(test.phase)), `Test ${test.name || test.id}: references an unavailable Rule or stage.`);
    add(test.expected_decision === "transform" && test.expected_text == null, `Test ${test.name || test.id}: assert the complete replacement output.`);
    add((test.expected_matched_rules ?? []).some(id => !rules.has(id)), `Test ${test.name || test.id}: expected matched Rule does not exist.`);
    add(test.kind === "rule_acceptance" && test.expected_matched_rules != null && test.covered_rule_ids.some(id => !test.expected_matched_rules!.includes(id)), `Test ${test.name || test.id}: acceptance tests must assert their Rule matches.`);
  }
  return issues;
}

function validThreshold(value: unknown): boolean {
  return (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1;
}

export function emptyPolicyDefinition(): PolicyDefinition {
  return { schema_version: 1, kind: "Policy", metadata: { id: `policy-${crypto.randomUUID()}`, name: "", description: "", version: "0", tags: [{ namespace: "protection", value: "content_filters", label: "Words & content filters", source: "declared" }], safety_level: "balanced", output_delivery: "full_buffered" }, rules: [], tests: [], parameters: [], execution: { mode: "sequential", input: "previous_output", stop_on: "block" } };
}
