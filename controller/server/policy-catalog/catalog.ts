import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";
import { guardrailCategoryIds } from "../../shared/guardrail-catalog.js";

const railTypeSchema = z.enum(["input", "retrieval", "dialog", "execution", "output"]);
const ruleFormSchema = z.enum(["regex", "keyword", "category", "code_block", "competitor_intent", "colang_flow"]);
const policyTagNamespaceSchema = z.enum([
  "guardrail_category",
  "collection",
  "domain",
  "framework",
  "implementation",
  "jurisdiction",
  "rail",
]);
const tagSchema = z.object({
  namespace: policyTagNamespaceSchema,
  value: z.string().min(1),
  label: z.string().min(1),
  source: z.enum(["declared", "derived"]).default("declared"),
}).superRefine((tag, context) => {
  if (tag.namespace === "guardrail_category" && !(guardrailCategoryIds as readonly string[]).includes(tag.value)) {
    context.addIssue({ code: "custom", path: ["value"], message: `Unknown Guardrail category ${tag.value}.` });
  }
});
const parameterSchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  kind: z.string().min(1),
  required: z.boolean(),
  placeholder: z.string().optional(),
  default: z.string().nullable().optional(),
  description: z.string().default(""),
});
const implementationSchema = z.object({
  engine: z.string().min(1),
  form: ruleFormSchema,
  binding_id: z.string().min(1),
  implementation_rule_id: z.string().min(1),
  detector: z.string().nullable().default(null),
  flow_name: z.string().nullable().default(null),
  action_name: z.string().nullable().default(null),
});
const stringPairSchema = z.tuple([z.string(), z.string()]);
const ruleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  form: ruleFormSchema,
  effect: z.string().min(1),
  rails: z.array(railTypeSchema),
  implementation: implementationSchema,
  expression: z.string().nullable().default(null),
  context_expression: z.string().nullable().default(null),
  context_max_gap_words: z.number().int().nonnegative().nullable().default(null),
  allow_word_numbers: z.boolean().default(false),
  redaction: z.string().nullable().default(null),
  severity_threshold: z.string().nullable().default(null),
  identifiers: z.array(z.string()).default([]),
  conditions: z.array(z.string()).default([]),
  keywords: z.array(stringPairSchema).default([]),
  always_block: z.array(stringPairSchema).default([]),
  exceptions: z.array(z.string()).default([]),
  phrase_patterns: z.array(z.string()).default([]),
  taxonomy_ids: z.array(z.string().regex(/^TALI(?:-[A-Z0-9]+)+$/)).default([]),
});
const testCaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  phase: railTypeSchema,
  content: z.string(),
  expected_decision: z.enum(["allow", "block", "transform", "intervene"]),
  covered_rule_ids: z.array(z.string()).default([]),
  group: z.string().default("General"),
  kind: z.enum(["rule_acceptance", "scenario"]).default("scenario"),
  required: z.boolean().default(true),
  parameter_names: z.array(z.string()).default([]),
});
const policyAssetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  source: z.enum(["built_in", "custom"]),
  version: z.string().min(1),
  tags: z.array(tagSchema).default([]),
  parameters: z.array(parameterSchema).default([]),
  rules: z.array(ruleSchema).default([]),
  test_cases: z.array(testCaseSchema).default([]),
  safety_level: z.enum(["balanced", "strict"]).default("balanced"),
  output_delivery: z.enum(["interruptible", "window_buffered", "full_buffered"]).default("window_buffered"),
});

type PolicyAsset = z.output<typeof policyAssetSchema>;
type PolicyRule = z.output<typeof ruleSchema>;
type PolicyTestCase = z.output<typeof testCaseSchema>;
type PolicyParameter = z.output<typeof parameterSchema>;

export type PolicyTag = z.output<typeof tagSchema> & { id: string };
export type PolicyDto = {
  implementation: "rules";
  id: string;
  name: string;
  description: string;
  source: "built_in" | "custom";
  version: string;
  tags: PolicyTag[];
  parameters: PolicyParameter[];
  rails: Array<z.output<typeof railTypeSchema>>;
  effects: string[];
  forms: Array<z.output<typeof ruleFormSchema>>;
  rules: PolicyRule[];
  test_cases: PolicyTestCase[];
  test_count: number;
  safety_level: "balanced" | "strict";
  output_delivery: "interruptible" | "window_buffered" | "full_buffered";
};

export const POLICY_CATALOG_FILE_NAMES = [
  "builtin_policies.json",
  "local_content_filters.json",
] as const;

const RAIL_ORDER: PolicyDto["rails"] = ["input", "retrieval", "dialog", "execution", "output"];

// Keep the Controller's discovery metadata compatible with the canonical
// Runner toolkit catalog. These tags are centrally reviewed metadata, not an
// assertion that every Rule covers every OWASP risk.
const OWASP_LLM_2025_POLICY_IDS = new Set([
  "builtin-prompt-injection",
  "builtin-indirect-prompt-injection",
  "builtin-jailbreak",
  "builtin-system-prompt-leakage",
  "prompt-injection-protection",
  "filter-prompt-injection-jailbreak",
  "filter-prompt-injection-data-exfiltration",
  "filter-prompt-injection-system-prompt",
  "claims-agent-safety",
  "builtin-secrets",
  "builtin-pii",
  "pattern-matching",
  "baseline-pii-protection",
  "advanced-au-pii-protection",
  "airline-passenger-data-protection-uae",
  "gdpr-eu-pii-protection",
  "pdpa-singapore",
  "uae-regulatory-compliance",
  "aviation-operations-security",
  "filter-prompt-injection-sql",
  "filter-prompt-injection-malicious-code",
  "block-code-execution",
  "builtin-contextual-grounding",
  "builtin-automated-reasoning",
  "mas-ai-risk-management",
]);

export class PolicyCatalog {
  private constructor(private readonly policiesById: ReadonlyMap<string, PolicyDto>) {}

  static load(directory: string): PolicyCatalog {
    const merged = new Map<string, PolicyDto>();
    for (const fileName of POLICY_CATALOG_FILE_NAMES) {
      const path = join(directory, fileName);
      for (const policy of readPolicyAssets(path)) {
        // The focused local-filter collection intentionally replaces a legacy
        // definition when it reuses a public Policy ID.
        merged.set(policy.id, normalizePolicy(policy));
      }
    }
    return new PolicyCatalog(merged);
  }

  list(): PolicyDto[] {
    return [...this.policiesById.values()];
  }

  get(policyId: string): PolicyDto | undefined {
    return this.policiesById.get(policyId);
  }
}

function readPolicyAssets(path: string): PolicyAsset[] {
  try {
    const payload: unknown = JSON.parse(readFileSync(path, "utf8"));
    return z.array(policyAssetSchema).parse(payload);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load Policy catalog asset ${path}: ${detail}`);
  }
}

function normalizePolicy(policy: PolicyAsset): PolicyDto {
  const tags = new Map<string, PolicyTag>();
  if (OWASP_LLM_2025_POLICY_IDS.has(policy.id)) {
    const tag = policyTag("framework", "owasp-llm-2025", "OWASP LLM 2025", "declared");
    tags.set(tag.id, tag);
  }
  for (const item of policy.tags) {
    const tag = policyTag(item.namespace, item.value, item.label, item.source);
    tags.set(tag.id, tag);
  }

  const configuredRails = new Set(policy.rules.flatMap((rule) => rule.rails));
  const effects = [...new Set(policy.rules.map((rule) => rule.effect))].sort();
  const forms = [...new Set(policy.rules.map((rule) => rule.form))].sort();
  return {
    implementation: "rules",
    id: policy.id,
    name: policy.name,
    description: policy.description,
    source: policy.source,
    version: policy.version,
    tags: [...tags.values()],
    parameters: policy.parameters,
    rails: RAIL_ORDER.filter((rail) => configuredRails.has(rail)),
    effects,
    forms,
    rules: policy.rules,
    test_cases: policy.test_cases,
    test_count: policy.test_cases.length,
    safety_level: policy.safety_level,
    output_delivery: policy.output_delivery,
  };
}

function policyTag(namespace: PolicyTag["namespace"], value: string, label: string, source: PolicyTag["source"]): PolicyTag {
  return { id: `${namespace}:${value}`, namespace, value, label, source };
}
