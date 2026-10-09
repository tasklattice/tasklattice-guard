import { createHash } from "node:crypto";
import { canonicalJson } from "../../shared/canonical-json.js";
import type { PolicyDto } from "../policy-catalog/catalog.js";
import type { ProgrammablePolicySnapshot } from "../policy-studio/model.js";

/**
 * A Policy version as a node of a release package's resource tree. A
 * Guardrail version references Policy versions; export carries every node it
 * references and import builds them first, before the Guardrail that uses
 * them. The definition is the Policy version's own native form:
 *
 * - catalog: a rule-based Policy from the Policy catalog (built in, or a custom
 *   catalog package), frozen as the plan freezes it, before any per-binding
 *   expansion of its Rules.
 * - programmable: a Policy Studio (Colang) version, as the Library's
 *   immutable snapshot (sources, Rail bindings, full Test Cases, checksum).
 *   The Artifact carries a projection of it.
 */
export type PolicyNodeKind = "catalog" | "programmable";
export type PolicyNode = { id: string; version: string; kind: PolicyNodeKind; definition: Record<string, unknown> };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** A Policy version's identity across environments: its definition alone, whoever uses it. */
export function policyNodeDigest(definition: Record<string, unknown>): string {
  return sha256(canonicalJson(definition));
}

/** The definition a plan freezes for a catalog Policy. A catalog change never alters it. */
export function frozenBuiltInDefinition(policy: PolicyDto): Record<string, unknown> {
  return {
    id: policy.id, name: policy.name, description: policy.description, source: policy.source, version: policy.version,
    tags: policy.tags.map(({ id: _id, ...tag }) => tag), parameters: policy.parameters,
    rules: policy.rules, test_cases: policy.test_cases, safety_level: policy.safety_level, output_delivery: policy.output_delivery,
  };
}

/** What a plan carries of a custom Policy version; Test Case inputs stay with the Policy. */
export function planPolicyVersion(policy: ProgrammablePolicySnapshot): Record<string, unknown> {
  return {
    policy_id: policy.policy_id,
    version: policy.version,
    name: policy.name,
    source: policy.source,
    colang_version: policy.colang_version,
    sources: policy.sources,
    parameter_schema: policy.parameter_schema.map((item) => [item.name, item.kind]),
    rail_bindings: policy.rail_bindings,
    action_references: policy.action_references,
    evaluation_contracts: policy.evaluation_contracts,
    prompt_dependencies: policy.prompt_dependencies,
    execution_contract: policy.execution_contract,
    test_cases: policy.test_cases.map((item) => [item.name, item.expected_decision]),
    checksum: policy.checksum,
  };
}

/** The checksum a custom Policy version is published with: its snapshot with an empty checksum. */
export function snapshotChecksum(snapshot: Record<string, unknown>): string {
  return sha256(canonicalJson({ ...snapshot, checksum: "" }));
}

/** The Policy versions a Guardrail binds, as they stand when its candidate is built. */
export function guardrailPolicyNodes(
  bindings: ReadonlyArray<{ policyId: string; policyVersion: string }>,
  catalog: readonly PolicyDto[],
  programmable: readonly ProgrammablePolicySnapshot[],
): PolicyNode[] {
  const fromCatalog = new Map(catalog.flatMap(policy => [policy, ...(policy.published_versions ?? [])]).map(policy => [`${policy.id}@${policy.version}`, policy]));
  const fromStudio = new Map(programmable.map(policy => [`${policy.policy_id}@${policy.version}`, policy]));
  const nodes = new Map<string, PolicyNode>();
  for (const { policyId: id, policyVersion: version } of bindings) {
    const key = `${id}@${version}`;
    const catalogPolicy = fromCatalog.get(key);
    const snapshot = fromStudio.get(key);
    if (catalogPolicy) nodes.set(key, { id, version, kind: "catalog", definition: frozenBuiltInDefinition(catalogPolicy) });
    else if (snapshot) nodes.set(key, { id, version, kind: "programmable", definition: snapshot as unknown as Record<string, unknown> });
  }
  return [...nodes.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : left.version < right.version ? -1 : 1);
}

const records = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value)
  ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";

/** The Policy versions a plan binds: the edges from a Guardrail version to its Policy nodes. */
export function planPolicyEdges(plan: Record<string, unknown>): Array<{ id: string; version: string }> {
  return records(plan.policy_bindings).map(binding => ({ id: text(binding.policy_id), version: text(binding.policy_version) }));
}

/** Built-in definitions frozen into a plan's content filter steps, keyed by Policy ID. */
export function planBuiltInDefinitions(plan: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>();
  for (const step of records(plan.steps)) {
    if (step.capability !== "builtin_content_filter") continue;
    const parameters = new Map((Array.isArray(step.parameters) ? step.parameters : []).filter(Array.isArray).map(pair => [String(pair[0]), String(pair[1] ?? "")]));
    let frozen: unknown = {};
    try {
      frozen = JSON.parse(parameters.get("policy_definitions_json") ?? "{}");
    } catch {
      continue;
    }
    for (const [id, definition] of Object.entries(frozen && typeof frozen === "object" ? frozen : {})) {
      if (definition && typeof definition === "object" && !Array.isArray(definition)) found.set(id, definition as Record<string, unknown>);
    }
  }
  return found;
}

/** Custom Policy projections carried by a plan, keyed by ID@version. */
export function planCustomVersions(plan: Record<string, unknown>): Map<string, Record<string, unknown>> {
  return new Map(records(plan.policy_versions).map(version => [`${text(version.policy_id)}@${text(version.version)}`, version]));
}

const RAIL_ORDER = ["input", "retrieval", "dialog", "execution", "output"];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];

/** A frozen built-in definition in the shape the Policy Library lists. */
export function builtInPolicyView(definition: Record<string, unknown>) {
  const rules = records(definition.rules);
  const testCases = records(definition.test_cases);
  const rails = new Set(rules.flatMap(rule => strings(rule.rails)));
  return {
    implementation: "rules" as const,
    id: text(definition.id), name: text(definition.name) || text(definition.id), description: text(definition.description),
    source: definition.source === "custom" ? "custom" as const : "built_in" as const, version: text(definition.version),
    tags: records(definition.tags).map(tag => ({ id: `${text(tag.namespace)}:${text(tag.value)}`, namespace: text(tag.namespace), value: text(tag.value), label: text(tag.label), source: text(tag.source) })),
    parameters: records(definition.parameters),
    rails: RAIL_ORDER.filter(rail => rails.has(rail)),
    effects: [...new Set(rules.map(rule => text(rule.effect)).filter(Boolean))].sort(),
    detectors: [...new Set(rules.map(rule => text((rule.detector as Record<string, unknown> | undefined)?.ref)).filter(Boolean))].sort(),
    rules, test_cases: testCases, test_count: testCases.length,
    safety_level: text(definition.safety_level) || "balanced", output_delivery: text(definition.output_delivery) || "window_buffered",
  };
}

/**
 * Whether a plan's frozen catalog definition was built from this node: it is
 * equal, except that a phrase Rule (rule_expansion) expands into one Rule per
 * entry the binding supplies, and Test Cases then cover the expanded Rules.
 */
export function derivesFromCatalogNode(node: Record<string, unknown>, frozen: Record<string, unknown>): boolean {
  const { rules: nodeRules, test_cases: nodeTests, ...nodeRest } = node;
  const { rules: frozenRules, test_cases: frozenTests, ...frozenRest } = frozen;
  if (canonicalJson(nodeRest) !== canonicalJson(frozenRest)) return false;
  const own = new Map(records(nodeRules).map(rule => [text(rule.id), rule]));
  const expanding = [...own.values()].filter(rule => rule.rule_expansion);
  const kept = new Set<string>();
  for (const rule of records(frozenRules)) {
    const original = own.get(text(rule.id));
    if (original) {
      if (canonicalJson(original) !== canonicalJson(rule)) return false;
      kept.add(text(rule.id));
    } else if (!expanding.some(parent => text(rule.id).startsWith(`${text(parent.id)}/`))) {
      return false;
    }
  }
  if ([...own.values()].some(rule => !rule.rule_expansion && !kept.has(text(rule.id)))) return false;
  const withoutCoverage = (value: unknown) => records(value).map(({ covered_rule_ids: _covered, ...test }) => canonicalJson(test));
  return canonicalJson(withoutCoverage(nodeTests)) === canonicalJson(withoutCoverage(frozenTests));
}
