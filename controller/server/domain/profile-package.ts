import { createHash } from "node:crypto";
import { canonicalJson } from "../../shared/canonical-json.js";
import type { ProtectionPreset } from "../../shared/protection-map.js";
import type { PolicyDto } from "../policy-catalog/catalog.js";

export type ProfilePackage = {
  schemaVersion: 1;
  profile: ProtectionPreset;
  policies: Array<{
    id: string;
    version: string;
    checksum: string;
    rules: Array<{ id: string; bindingId: string | null; ruleVersion: string | null }>;
  }>;
};

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

function selectedRules(policy: PolicyDto, enabled: readonly string[]) {
  return policy.rules.filter(rule => enabled.includes(rule.id)).map(rule => ({
    id: rule.id,
    bindingId: rule.binding_id ?? null,
    ruleVersion: rule.rule_version ?? null,
  }));
}

/**
 * A Profile package pins every selected Policy version and the exact Rule
 * identities it enables. Rule payloads remain in the catalog closure; the
 * digests make a version substitution or Rule replacement detectable.
 */
export function exportProfilePackage(
  profile: ProtectionPreset,
  policies: readonly PolicyDto[],
): ProfilePackage {
  const byKey = new Map(policies.map(policy => [`${policy.id}@${policy.version}`, policy]));
  const pinned = profile.policies.map(reference => {
    const policy = byKey.get(`${reference.policyId}@${reference.policyVersion}`);
    if (!policy) throw new Error(`Profile ${profile.id}: Policy ${reference.policyId}@${reference.policyVersion} is unavailable.`);
    const enabled = reference.enabledRuleIds ?? policy.rules.map(rule => rule.id);
    const rules = selectedRules(policy, enabled);
    if (rules.length !== enabled.length) throw new Error(`Profile ${profile.id}: Policy ${policy.id} enables an unknown Rule.`);
    return {
      id: policy.id,
      version: policy.version,
      checksum: digest({ id: policy.id, version: policy.version, rules: policy.rules }),
      rules,
    };
  });
  return { schemaVersion: 1, profile: structuredClone(profile), policies: pinned };
}

export function importProfilePackage(
  value: unknown,
  policies: readonly PolicyDto[],
): ProtectionPreset {
  const input = value as ProfilePackage;
  if (!input || input.schemaVersion !== 1 || !input.profile || !Array.isArray(input.policies)) {
    throw new Error("Invalid Profile package.");
  }
  const byKey = new Map(policies.map(policy => [`${policy.id}@${policy.version}`, policy]));
  for (const pinned of input.policies) {
    const policy = byKey.get(`${pinned.id}@${pinned.version}`);
    if (!policy) throw new Error(`Profile package Policy ${pinned.id}@${pinned.version} is unavailable.`);
    if (digest({ id: policy.id, version: policy.version, rules: policy.rules }) !== pinned.checksum) {
      throw new Error(`Profile package checksum mismatch for ${pinned.id}@${pinned.version}.`);
    }
    const selected = selectedRules(policy, pinned.rules.map(rule => rule.id));
    if (selected.length !== pinned.rules.length
      || selected.some((rule, index) => rule.bindingId !== pinned.rules[index]!.bindingId
        || rule.ruleVersion !== pinned.rules[index]!.ruleVersion)) {
      throw new Error(`Profile package Rule identity mismatch for ${pinned.id}@${pinned.version}.`);
    }
  }
  const refs = new Set(input.profile.policies.map(reference => `${reference.policyId}@${reference.policyVersion}`));
  if (refs.size !== input.policies.length || input.policies.some(pinned => !refs.has(`${pinned.id}@${pinned.version}`))) {
    throw new Error("Profile package dependency closure does not match the Profile bindings.");
  }
  return structuredClone(input.profile);
}
