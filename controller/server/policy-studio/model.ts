import { z } from "zod";
import { enforcementActions } from "../../shared/enforcement-action.generated.js";

export const policyRailTypes = ["input", "output"] as const;

const sourceSchema = z.object({
  path: z.string().trim().min(1).max(512),
  content: z.string().min(1).max(500_000),
});

const parameterSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["string", "number", "boolean", "secret"]),
  required: z.boolean().default(false),
  default: z.string().nullable().default(null),
  description: z.string().max(1_000).default(""),
});

const railBindingSchema = z.object({
  rail_type: z.enum(policyRailTypes),
  flow_name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  execution_mode: z.enum(["detect", "mutate"]),
  // on_unsafe is an EnforcementAction directive, not a PolicyDecision. The
  // values come from the shared Controller/Runner wire contract.
  on_unsafe: z.enum(enforcementActions),
  parallel_group: z.string().trim().min(1).max(120).nullable().default(null),
  priority: z.number().int().nullable().default(null),
  timeout_ms: z.number().int().positive().max(120_000).default(2_000),
  failure_mode: z.enum(["fail_open", "fail_closed"]).default("fail_closed"),
  required: z.boolean().default(true),
  depends_on: z.array(z.string().trim().min(1).max(120)).max(32).default([]),
});

const actionReferenceSchema = z.object({
  name: z.string().trim().min(1).max(160),
  version: z.string().trim().min(1).max(64),
});

const policyTestCaseSchema = z.object({
  id: z.string().trim().max(256).default(""),
  description: z.string().max(2_000).default(""),
  name: z.string().trim().min(1).max(160),
  rail_type: z.enum(policyRailTypes),
  content: z.string().min(1).max(8_000),
  expected_decision: z.enum(["allow", "block", "transform"]),
  covered_rule_ids: z.array(z.string().trim().min(1).max(256)).min(1).max(64),
  case_type: z.enum(["unit", "input_rail", "output_rail", "timeout", "provider_failure", "concurrency"]),
  required: z.boolean().default(true),
  expected_failure: z.enum(["timeout", "provider_failure"]).nullable().default(null),
  concurrency_group: z.string().trim().min(1).max(120).nullable().default(null),
  trusted_instruction: z.string().max(8_000).default(""),
  use_guardrail_instruction: z.boolean().default(false),
  for_each: z.enum(["allowed_topics", "restricted_topics"]).nullable().default(null),
  target_source: z.enum(["user_input", "retrieved_content", "tool_output", "model_output"]).default("user_input"),
  query: z.string().max(1_000).default(""),
  grounding_sources: z.array(z.string().max(8_000)).max(32).default([]),
  expected_reasoning_result: z.enum(["valid", "invalid", "satisfiable", "impossible", "translation_ambiguous", "too_complex", "no_translations"]).nullable().default(null),
});

export const programmablePolicyDraftSchema = z.object({
  colang_version: z.enum(["1.0", "2.x"]).default("2.x"),
  sources: z.array(sourceSchema).min(1).max(32),
  parameter_schema: z.array(parameterSchema).max(128).default([]),
  rail_bindings: z.array(railBindingSchema).min(1).max(32),
  action_references: z.array(actionReferenceSchema).max(64).default([]),
  model_dependencies: z.array(z.string().trim().min(1).max(256)).max(32).default([]),
  prompt_dependencies: z.array(z.string().trim().min(1).max(256)).max(32).default([]),
  execution_contract: z.array(z.tuple([z.string().trim().min(1).max(128), z.string().max(2_000)])).max(64).default([]),
  test_cases: z.array(policyTestCaseSchema).max(256).default([]),
});

export const createProgrammablePolicySchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).default(""),
  owner: z.string().trim().min(1).max(256),
  draft: programmablePolicyDraftSchema,
});

export const updateProgrammablePolicySchema = createProgrammablePolicySchema.partial();

export type ProgrammablePolicyDraft = z.output<typeof programmablePolicyDraftSchema>;

export type ProgrammablePolicySnapshot = Omit<ProgrammablePolicyDraft, "execution_contract"> & {
  policy_id: string;
  version: string;
  name: string;
  description: string;
  source: "built_in" | "custom";
  owner: string;
  execution_contract: Array<[string, string]>;
  checksum: string;
  published_at: string;
};

export type PolicyValidationResult = {
  name: string;
  case_type: string;
  required: boolean;
  rail_type: "input" | "output";
  concurrency_group: string | null;
  expected_decision: string;
  expected_failure: string | null;
  actual_decision: string;
  actual_failure: string | null;
  passed: boolean;
  latency_ms: number;
  reason: string;
  covered_rule_ids: string[];
  matched_rule_ids: string[];
  trace: Array<Record<string, unknown>>;
};

export function flowRuleId(rail: string, flow: string): string {
  return `flow/${rail}/${flow}`;
}
