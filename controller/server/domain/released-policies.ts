import { createHash } from "node:crypto";
import { canonicalJson } from "../../shared/canonical-json.js";

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
  latest: boolean;
  /** Referenced by an enabled, weighted target of an active Router revision. */
  serving: boolean;
  /** This Guardrail's configuration of the Policy: enabled Rules and action. */
  enabledRuleIds: string[];
  action: string | null;
  phases: string[];
};

export type ReleasedPolicyVersion = {
  version: string;
  /** SHA-256 of the frozen definition; null when the plan carries none. */
  contentDigest: string | null;
  name: string;
  description: string;
  rules: Array<{ id: string; name: string; action: string | null; phases: string[] }>;
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
  latest: boolean;
  serving: boolean;
  plan: Record<string, unknown>;
};

type Definition = { source: "built_in" | "custom"; digest: string | null; name: string; description: string; rules: ReleasedPolicyVersion["rules"] };

const records = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value)
  ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";

/** Frozen definitions carried by one plan, keyed by ID@version. */
function definitions(plan: Record<string, unknown>): Map<string, Definition> {
  const found = new Map<string, Definition>();
  for (const step of records(plan.steps)) {
    if (step.capability !== "builtin_content_filter") continue;
    const parameters = new Map((Array.isArray(step.parameters) ? step.parameters : [])
      .filter(Array.isArray).map(pair => [String(pair[0]), String(pair[1] ?? "")]));
    let frozen: Record<string, Record<string, unknown>> = {};
    try {
      frozen = JSON.parse(parameters.get("policy_definitions_json") ?? "{}") ?? {};
    } catch {
      continue;
    }
    for (const [id, definition] of Object.entries(frozen)) {
      if (!definition || typeof definition !== "object") continue;
      found.set(`${id}@${text(definition.version)}`, {
        source: "built_in",
        digest: createHash("sha256").update(canonicalJson(definition)).digest("hex"),
        name: text(definition.name) || id,
        description: text(definition.description),
        rules: records(definition.rules).map(rule => ({ id: text(rule.id), name: text(rule.name) || text(rule.id), action: text(rule.effect) || null, phases: strings(rule.rails) })),
      });
    }
  }
  for (const version of records(plan.policy_versions)) {
    const id = text(version.policy_id);
    found.set(`${id}@${text(version.version)}`, {
      source: "custom",
      digest: text(version.checksum) || null,
      name: text(version.name) || id,
      description: text(version.description),
      rules: records(version.rail_bindings).map(binding => {
        const rail = text(binding.rail_type), flow = text(binding.flow_name);
        return { id: `flow/${rail}/${flow}`, name: flow, action: text(binding.on_unsafe) || null, phases: rail ? [rail] : [] };
      }),
    });
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
      const policy = policies.get(policyId) ?? { source: definition?.source ?? "built_in", versions: new Map() };
      policies.set(policyId, policy);
      const key = `${version}\u0000${definition?.digest ?? ""}`;
      const entry = policy.versions.get(key) ?? {
        version, contentDigest: definition?.digest ?? null, name: definition?.name ?? policyId,
        description: definition?.description ?? "", rules: definition?.rules ?? [], usage: [],
      };
      policy.versions.set(key, entry);
      entry.usage.push({
        guardrailId: row.guardrailId, guardrailName: row.guardrailName, guardrailVersion: row.guardrailVersion,
        origin: row.origin, sourceId: row.sourceId, latest: row.latest, serving: row.serving,
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
