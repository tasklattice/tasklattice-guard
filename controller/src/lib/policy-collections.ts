import type { GuardrailProfilePreview } from "./guardrails-api";
import type { GuardrailPolicyBinding, Policy, PolicyRule, PolicyTag } from "./api";
import { boundPolicy } from "./bound-policy";
import { policyDirectory } from "./protection-composition";
import type { ProtectionDirectoryId } from "../../shared/protection-map";
import type { PolicyCompliance } from "../../shared/policy-compliance";

// Presentation metadata only. Enabled Profiles and their exact versioned Rule
// selections come from the control plane; no executable definitions live here.
const frameworks: Record<string, [string, string][]> = {
  "eu-data-protection": [["gdpr", "GDPR"]],
  "singapore-data-protection": [["pdpa", "Singapore PDPA"]],
  "singapore-financial-assistant": [["pdpa", "Singapore PDPA"]],
  "china-mainland-runtime": [["pipl-cn", "PIPL (China)"]],
  "china-banking-assistant": [["pipl-cn", "PIPL (China)"], ["jr-t-0221-2021", "JR/T 0221-2021"]],
  "eu-high-risk-practices": [["eu-ai-act", "EU AI Act"]],
};
const regionLabels: Record<string, string> = { au: "Australia", cn: "China mainland", eu: "European Union", sg: "Singapore", uae: "United Arab Emirates" };

export type PolicyCollection = {
  id: string;
  name: string;
  description: string;
  profile: GuardrailProfilePreview;
  tags: PolicyTag[];
  directories: ProtectionDirectoryId[];
  groups: { binding: GuardrailPolicyBinding; policy: Policy | undefined; rules: PolicyRule[] }[];
  ruleCount: number;
  unavailable: string[];
};

export function policyCollections(profiles: readonly GuardrailProfilePreview[], policies: readonly Policy[]): PolicyCollection[] {
  return profiles.map(profile => {
    const tags: PolicyTag[] = [
      ...[...new Set(profile.jurisdictions.map(value => value === "singapore" ? "sg" : value))].map(value => ({ id: `jurisdiction:${value}`, namespace: "jurisdiction" as const, value, label: regionLabels[value] ?? value, source: "declared" as const })),
      ...(frameworks[profile.id] ?? []).map(([value, label]) => ({ id: `framework:${value}`, namespace: "framework" as const, value, label, source: "declared" as const })),
    ];
    const unavailable: string[] = profile.availability?.available === false ? [profile.availability.reason ?? profile.id] : [];
    const groups = profile.bindings.map(binding => {
      const policy = boundPolicy(policies, binding);
      if (!policy) unavailable.push(`${binding.policy_id}@${binding.policy_version}`);
      const enabled = new Set(binding.enabled_rule_ids);
      const orderedIds = [...new Set([...(binding.rule_order ?? []), ...binding.enabled_rule_ids])].filter(id => enabled.has(id));
      const rules = orderedIds.flatMap(id => {
        const rule = policy?.rules.find(item => item.id === id);
        if (!rule) { if (policy) unavailable.push(`${binding.policy_id}/${id}`); return []; }
        return [rule];
      });
      return { binding, policy, rules };
    });
    return {
      id: profile.id, name: profile.name, description: profile.description, profile, tags, groups, unavailable,
      directories: [...new Set(groups.flatMap(group => group.policy ? [policyDirectory(group.policy)] : []))],
      ruleCount: new Set(groups.flatMap(({ binding, rules }) => rules.map(rule => `${binding.policy_id}@${binding.policy_version}/${rule.id}`))).size,
    };
  }).sort((a, b) => Number(b.tags.length > 0) - Number(a.tags.length > 0));
}

export type CatalogItem = Policy | PolicyCollection;
export function catalogDirectories(item: CatalogItem): ProtectionDirectoryId[] {
  return "profile" in item ? item.directories : [policyDirectory(item)];
}

/** A read-only Policy view of the exact selected Rules, independent of storage grouping. */
export function collectionAsPolicy(collection: PolicyCollection): Policy {
  const ruleCounts = new Map<string, number>();
  for (const group of collection.groups) for (const rule of group.rules) ruleCounts.set(rule.id, (ruleCounts.get(rule.id) ?? 0) + 1);
  const ruleId = (binding: GuardrailPolicyBinding, id: string) => (ruleCounts.get(id) ?? 0) > 1 ? `${binding.policy_id}@${binding.policy_version}/${id}` : id;
  const rules = collection.groups.flatMap(({ binding, rules }) => rules.map(rule => ({ ...rule,
    id: ruleId(binding, rule.id), effect: binding.rule_actions[rule.id] ?? binding.action ?? rule.effect,
    rails: binding.enabled_rails.length ? rule.rails.filter(rail => binding.enabled_rails.includes(rail)) : rule.rails,
  })));
  const tests = collection.groups.flatMap(({ binding, policy, rules }) => {
    const selected = new Set(rules.map(rule => rule.id));
    if (!rules.length) return [];
    return (policy?.test_cases ?? []).filter(test => (!binding.enabled_rails.length || binding.enabled_rails.includes(test.phase))
      && test.covered_rule_ids.every(id => selected.has(id))).map(test => {
      const override = binding.test_case_overrides?.[test.id];
      return { ...test, id: `${binding.policy_id}@${binding.policy_version}/${test.id}`,
        covered_rule_ids: test.covered_rule_ids.map(id => ruleId(binding, id)),
        expected_decision: override?.sourcePolicyVersion === binding.policy_version ? override.expectedDecision : test.expected_decision,
      };
    });
  });
  return {
    id: collection.id, version: collection.profile.version, name: collection.name, description: collection.description,
    implementation: "rules", source: "built_in", tags: collection.tags, parameters: [], rules, test_cases: tests, test_count: tests.length,
    rails: [...new Set(rules.flatMap(rule => rule.rails))], effects: [...new Set(rules.map(rule => rule.effect))],
    detectors: [...new Set(rules.map(rule => rule.detector.ref))], safety_level: "balanced", output_delivery: "full_buffered",
    compliance: collectionCompliance(collection, ruleId),
  };
}

function collectionCompliance(collection: PolicyCollection, ruleId: (binding: GuardrailPolicyBinding, id: string) => string): PolicyCompliance | undefined {
  const documents = collection.groups.flatMap(({ binding, policy, rules }) => {
    const document = policy?.compliance;
    if (!document || document.policy_version !== binding.policy_version || !rules.length) return [];
    const selected = new Set(rules.map(rule => rule.id));
    const selectIds = (ids: string[]) => ids.filter(id => selected.has(id)).map(id => ruleId(binding, id));
    return [{ ...document,
      references: document.references.map(ref => ({ ...ref, rule_ids: selectIds(ref.rule_ids) })).filter(ref => ref.rule_ids.length),
      coverage: document.coverage.map(entry => ({ ...entry, rule_ids: selectIds(entry.rule_ids) })).filter(entry => entry.rule_ids.length),
    }];
  });
  if (!documents.length) return undefined;
  const unique = <T,>(values: T[]): T[] => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
  const join = (values: { en: string; zh: string }[]) => ({ en: [...new Set(values.map(value => value.en))].join("\n\n"), zh: [...new Set(values.map(value => value.zh))].join("\n\n") });
  const references = new Map<string, PolicyCompliance["references"][number]>();
  for (const reference of documents.flatMap(document => document.references)) {
    const key = JSON.stringify([reference.url, reference.provision, reference.relevance]);
    const existing = references.get(key);
    references.set(key, existing ? { ...existing, rule_ids: [...new Set([...existing.rule_ids, ...reference.rule_ids])] } : reference);
  }
  const labels = collection.tags.map(tag => tag.label).join(" · ");
  return {
    policy_version: collection.profile.version,
    summary: { en: collection.description, zh: collection.description },
    jurisdiction: labels ? { en: labels, zh: labels } : { en: "No specific jurisdiction is declared.", zh: "未指定特定司法辖区。" },
    provenance: { en: "This documentation covers the Rules selected in this Policy version.", zh: "此说明对应本 Policy 版本中选定的 Rules。" },
    maintainer: [...new Set(documents.map(document => document.maintainer))].join(", "),
    upstream_status: join(documents.map(document => document.upstream_status)),
    license_status: join(documents.map(document => document.license_status)),
    references: [...references.values()], coverage: unique(documents.flatMap(document => document.coverage)),
    limitations: unique([...collection.profile.limitations.map(text => ({ en: text, zh: text })), ...documents.flatMap(document => document.limitations)]),
    // A Rule's documentation review does not certify a different Policy selection.
    review: { status: "pending", reviewed_on: null, reviewer: null,
      notes: { en: "Review the selected Rule coverage and applicability for this Policy version before making compliance claims.", zh: "在作出合规判断前，需审查本 Policy 版本所选 Rule 的覆盖范围与适用性。" } },
  };
}
