import { capabilityBindingDefinitions, type CapabilityBindingId } from "../../shared/guardrail-catalog";
import { evaluationContractDependencies } from "../../shared/protection-dependencies";
import type { GuardrailPolicyBinding, Policy } from "./api-types";
import { boundPolicy } from "./bound-policy";
import type { ModelConfigurationView, ModelConfigurationRevision } from "./controller-api";

/** Navigation categories never imply executable dependencies. Directions and enabled Rules do. */
export function selectedModelDependencies(bindings: GuardrailPolicyBinding[], policies: Policy[]) {
  const required = new Map<CapabilityBindingId, string[]>();
  const unknownPolicies: string[] = [];
  for (const binding of bindings) {
    const policy = boundPolicy(policies, binding);
    if (!binding.enabled_rule_ids.length || !binding.enabled_rails.length) continue;
    if (!policy?.protection) {
      unknownPolicies.push(policy?.name ?? binding.policy_id);
      continue;
    }
    if (policy.protection.execution === "custom") unknownPolicies.push(policy.name);
    if (!policy.protection.evaluationContracts && !policy.protection.modelCapabilities.length) continue;
    const selectedRules = policy.rules.filter(rule => binding.enabled_rule_ids.includes(rule.id));
    if (selectedRules.some(rule => !Array.isArray(rule.rails))) unknownPolicies.push(policy.name);
    const directions = binding.enabled_rails.filter(rail => (rail === "input" || rail === "output")
      && selectedRules.some(rule => Array.isArray(rule.rails) && rule.rails.includes(rail)));
    if (policy.protection.evaluationContracts) {
      for (const contract of policy.protection.evaluationContracts) for (const rail of directions) {
        if (rail !== "input" && rail !== "output") continue;
        const resolved = evaluationContractDependencies(contract, rail);
        if (resolved.unknown) unknownPolicies.push(policy.name);
        for (const definition of resolved.bindings) required.set(definition.id,
          [...new Set([...(required.get(definition.id) ?? []), policy.name])]);
      }
      continue;
    }
    for (const capability of policy.protection.modelCapabilities) {
      for (const rail of directions) {
        const definition = capabilityBindingDefinitions.find(item => item.capabilityRef === capability && item.railType === rail);
        if (!definition) { unknownPolicies.push(policy.name); continue; }
        required.set(definition.id, [...new Set([...(required.get(definition.id) ?? []), policy.name])]);
      }
    }
  }
  return { required: [...required].map(([id, policyNames]) => ({ id, policyNames })), unknownPolicies: [...new Set(unknownPolicies)] };
}

export type DependencyAssignmentState = "active" | "activating" | "validated" | "failed" | "unverified" | "missing";
export function dependencyAssignment(id: CapabilityBindingId, view: ModelConfigurationView) {
  const inspect = (revision: ModelConfigurationRevision, stage: "active" | "activating" | "draft") => {
    const modelId = revision.assignments.bindings[id];
    if (!modelId) return null;
    const model = view.models.find(item => item.id === modelId);
    const probe = revision.validationReport?.checks.find(check => check.id === `probe:${id}:${modelId}`);
    const state: DependencyAssignmentState = probe?.status === "failed" ? "failed"
      : model && probe?.status === "passed" && probe.evidenceKind === "nemo-rail-v1"
        ? stage === "draft" ? "validated" : stage : "unverified";
    return { state, modelName: model?.name ?? modelId, checkedAt: revision.validationReport?.checkedAt ?? null, revision: revision.revision };
  };
  // A failed/newer draft does not replace the last active runtime assignment.
  return (view.active && inspect(view.active, "active"))
    || (view.activating && inspect(view.activating, "activating"))
    || (view.draft && inspect(view.draft, "draft"))
    || { state: "missing" as const, modelName: null, checkedAt: null, revision: null };
}
