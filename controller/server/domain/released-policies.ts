import { createHash } from "node:crypto";
import { canonicalJson } from "../../shared/canonical-json.js";
import { flowRule } from "../policy-studio/model.js";

/**
 * Policies as they are actually released: the frozen definitions inside
 * Guardrail version plans, grouped by Policy ID. This never reads a Policy
 * Library, so it is the authority wherever Policies are not authored.
 *
 * Identity: a Policy is its ID; a Policy version is ID@version plus the digest
 * of its frozen definition, so two sources releasing the same version number
 * with different content stay apart. Names are display data and may differ
 * between versions.
 */
export type ReleasedPolicyUsage = {
  guardrailId: string;
  guardrailName: string;
  guardrailVersion: string;
  /** "imported" versions arrived in a release package from sourceId. */
  origin: "local" | "imported";
  sourceId: string | null;
  /** Referenced by an enabled, weighted target of an active Router revision. */
  serving: boolean;
  /** This Guardrail's configuration of the Policy: enabled Rules and action. */
  enabledRuleIds: string[];
  action: string | null;
  phases: string[];
};

/**
 * The frozen definition in the shape a Policy Library lists, so a receiving
 * environment renders released Policies with the same views. Fields a release
 * does not carry (compliance notes, a custom Policy's test inputs) are absent
 * rather than invented.
 */
export type ReleasedPolicyDefinition = {
  implementation: "rules" | "nemo_native";
  id: string;
  name: string;
  description: string;
  source: "built_in" | "custom";
  version: string;
  tags: Array<{ id: string; namespace: string; value: string; label: string; source: string }>;
  parameters: Array<Record<string, unknown>>;
  rails: string[];
  effects: string[];
  detectors: string[];
  rules: Array<Record<string, unknown>>;
  test_cases: Array<Record<string, unknown>>;
  test_count: number;
  safety_level: string;
  output_delivery: string;
};

export type ReleasedPolicyVersion = {
  version: string;
  /** SHA-256 of the frozen definition; null when the plan carries none. */
  contentDigest: string | null;
  name: string;
  definition: ReleasedPolicyDefinition;
  usage: ReleasedPolicyUsage[];
};

export type ReleasedPolicy = {
  policyId: string;
  /** Name of the version currently serving traffic, else of the newest usage. */
  name: string;
  source: "built_in" | "custom";
  serving: boolean;
  versions: ReleasedPolicyVersion[];
  /** Version numbers released with more than one distinct definition. */
  conflictingVersions: string[];
};

export type ReleasedGuardrailVersion = {
  guardrailId: string;
  guardrailName: string;
  guardrailVersion: string;
  origin: "local" | "imported";
  sourceId: string | null;
  serving: boolean;
  plan: Record<string, unknown>;
};

type Definition = { digest: string | null; definition: ReleasedPolicyDefinition };

const records = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value)
  ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";
const pairs = (value: unknown): Array<[string, string]> => Array.isArray(value)
  ? value.filter(Array.isArray).map(pair => [String(pair[0]), String(pair[1] ?? "")]) : [];

const RAIL_ORDER = ["input", "retrieval", "dialog", "execution", "output"];

function surface(rules: Array<Record<string, unknown>>) {
  const rails = new Set(rules.flatMap(rule => strings(rule.rails)));
  return {
    rails: RAIL_ORDER.filter(rail => rails.has(rail)),
    effects: [...new Set(rules.map(rule => text(rule.effect)).filter(Boolean))].sort(),
    detectors: [...new Set(rules.map(rule => text((rule.detector as Record<string, unknown> | undefined)?.ref)).filter(Boolean))].sort(),
  };
}

function builtInDefinition(id: string, frozen: Record<string, unknown>): ReleasedPolicyDefinition {
  const rules = records(frozen.rules);
  const testCases = records(frozen.test_cases);
  return {
    implementation: "rules", id, name: text(frozen.name) || id, description: text(frozen.description),
    source: frozen.source === "custom" ? "custom" : "built_in", version: text(frozen.version),
    tags: records(frozen.tags).map(tag => ({ id: `${text(tag.namespace)}:${text(tag.value)}`, namespace: text(tag.namespace), value: text(tag.value), label: text(tag.label), source: text(tag.source) })),
    parameters: records(frozen.parameters), ...surface(rules), rules, test_cases: testCases, test_count: testCases.length,
    safety_level: text(frozen.safety_level) || "balanced", output_delivery: text(frozen.output_delivery) || "window_buffered",
  };
}

function customDefinition(frozen: Record<string, unknown>): ReleasedPolicyDefinition {
  const id = text(frozen.policy_id), version = text(frozen.version);
  const rules = records(frozen.rail_bindings).map(binding => flowRule(id, version, {
    rail_type: text(binding.rail_type) as "input", flow_name: text(binding.flow_name),
    on_unsafe: text(binding.on_unsafe) as "block", risk_severity: (binding.risk_severity ?? null) as null,
  }));
  // A release keeps each test's name and expected decision, not its input.
  const testCases = pairs(frozen.test_cases).map(([name, expected], index) => ({
    id: `release/${index + 1}`, name, description: "", content: "", expected_decision: expected,
    covered_rule_ids: [], group: "Policy validation", kind: "scenario", required: true, parameter_names: [],
  }));
  const colang = text(frozen.colang_version);
  const delivery = new Map(pairs(frozen.execution_contract)).get("output_delivery");
  const { rails, effects, detectors } = surface(rules);
  return {
    implementation: "nemo_native", id, name: text(frozen.name) || id, description: text(frozen.description), source: "custom", version,
    tags: [
      ...(colang ? [{ id: `implementation:colang-${colang}`, namespace: "implementation", value: `colang-${colang}`, label: `Colang ${colang}`, source: "derived" }] : []),
      ...rails.map(rail => ({ id: `rail:${rail}`, namespace: "rail", value: rail, label: `${rail[0]!.toUpperCase()}${rail.slice(1)} rail`, source: "derived" })),
    ],
    parameters: pairs(frozen.parameter_schema).map(([name, kind]) => ({ name, kind, required: false, default: null, description: "" })),
    rails, effects, detectors, rules, test_cases: testCases, test_count: testCases.length, safety_level: "balanced",
    output_delivery: delivery === "interruptible" || delivery === "full_buffered" ? delivery : "window_buffered",
  };
}

/** A binding whose plan carries no frozen definition is still listed, with nothing invented. */
function unknownDefinition(id: string, version: string): ReleasedPolicyDefinition {
  return { implementation: "rules", id, name: id, description: "", source: "built_in", version, tags: [], parameters: [],
    rails: [], effects: [], detectors: [], rules: [], test_cases: [], test_count: 0, safety_level: "balanced", output_delivery: "window_buffered" };
}

/** Frozen definitions carried by one plan, keyed by ID@version. */
function definitions(plan: Record<string, unknown>): Map<string, Definition> {
  const found = new Map<string, Definition>();
  for (const step of records(plan.steps)) {
    if (step.capability !== "builtin_content_filter") continue;
    const parameters = new Map(pairs(step.parameters));
    let frozen: Record<string, Record<string, unknown>> = {};
    try {
      frozen = JSON.parse(parameters.get("policy_definitions_json") ?? "{}") ?? {};
    } catch {
      continue;
    }
    for (const [id, definition] of Object.entries(frozen)) {
      if (!definition || typeof definition !== "object") continue;
      found.set(`${id}@${text(definition.version)}`, {
        digest: createHash("sha256").update(canonicalJson(definition)).digest("hex"),
        definition: builtInDefinition(id, definition),
      });
    }
  }
  for (const version of records(plan.policy_versions)) {
    found.set(`${text(version.policy_id)}@${text(version.version)}`, { digest: text(version.checksum) || null, definition: customDefinition(version) });
  }
  return found;
}

export function aggregateReleasedPolicies(rows: ReleasedGuardrailVersion[]): ReleasedPolicy[] {
  const policies = new Map<string, { source: "built_in" | "custom"; versions: Map<string, ReleasedPolicyVersion> }>();
  for (const row of rows) {
    const frozen = definitions(row.plan);
    for (const binding of records(row.plan.policy_bindings)) {
      const policyId = text(binding.policy_id);
      const version = text(binding.policy_version);
      if (!policyId) continue;
      const definition = frozen.get(`${policyId}@${version}`);
      const policy = policies.get(policyId) ?? { source: definition?.definition.source ?? "built_in", versions: new Map() };
      policies.set(policyId, policy);
      const key = `${version}\u0000${definition?.digest ?? ""}`;
      const entry = policy.versions.get(key) ?? {
        version, contentDigest: definition?.digest ?? null, name: definition?.definition.name ?? policyId,
        definition: definition?.definition ?? unknownDefinition(policyId, version), usage: [],
      };
      policy.versions.set(key, entry);
      entry.usage.push({
        guardrailId: row.guardrailId, guardrailName: row.guardrailName, guardrailVersion: row.guardrailVersion,
        origin: row.origin, sourceId: row.sourceId, serving: row.serving,
        enabledRuleIds: strings(binding.enabled_rule_ids), action: text(binding.action) || null, phases: strings(binding.enabled_rails),
      });
    }
  }
  // Newest use first; serving traffic outranks merely released.
  const rank = (usage: ReleasedPolicyUsage[]) => [usage.some(item => item.serving) ? 1 : 0, usage.map(item => item.guardrailVersion).sort().at(-1) ?? ""] as const;
  const newerFirst = (left: ReleasedPolicyVersion, right: ReleasedPolicyVersion) => {
    const [ls, lv] = rank(left.usage), [rs, rv] = rank(right.usage);
    return rs - ls || (rv < lv ? -1 : rv > lv ? 1 : 0);
  };
  return [...policies].map(([policyId, policy]) => {
    const versions = [...policy.versions.values()].sort(newerFirst);
    for (const version of versions) version.usage.sort((left, right) => Number(right.serving) - Number(left.serving) || (right.guardrailVersion < left.guardrailVersion ? -1 : 1));
    const counts = new Map<string, number>();
    for (const version of versions) counts.set(version.version, (counts.get(version.version) ?? 0) + 1);
    return {
      policyId,
      name: versions[0]?.name ?? policyId,
      source: policy.source,
      serving: versions.some(version => version.usage.some(item => item.serving)),
      versions,
      conflictingVersions: [...counts].filter(([, count]) => count > 1).map(([version]) => version).sort(),
    };
  }).sort((left, right) => Number(right.serving) - Number(left.serving) || left.name.localeCompare(right.name));
}
