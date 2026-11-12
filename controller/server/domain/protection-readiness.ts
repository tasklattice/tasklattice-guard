import type { CapabilityBindingId } from "../../shared/guardrail-catalog.js";
import type { ProtectionCoverage } from "../../shared/platform-status.js";
import { evaluationContractDependencies } from "../../shared/protection-dependencies.js";
import { flowRuleId } from "../policy-studio/model.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Inspect immutable compiler output; do not infer protection from a Policy name. */
export function publishedProtectionCoverage(value: unknown): ProtectionCoverage | null {
  const plan = record(value);
  if (!Array.isArray(plan.steps) || !Array.isArray(plan.policy_bindings)) return null;
  const required = new Set<CapabilityBindingId>();
  const coverage: ProtectionCoverage = {
    policyCount: 0, inputChecks: 0, outputChecks: 0, requiredModelBindings: [], hasUnknownDependencies: false,
  };
  const coveredPolicies = new Set<string>();
  const dependencies = (contract: unknown, phase: "input" | "output") => {
    const resolved = evaluationContractDependencies(contract, phase);
    if (resolved.unknown) coverage.hasUnknownDependencies = true;
    for (const binding of resolved.bindings) required.add(binding.id);
  };
  for (const value of plan.steps) {
    const step = record(value);
    const phases = list(step.phases).filter((phase) => phase === "input" || phase === "output");
    for (const phase of new Set(phases)) {
      coverage[phase === "input" ? "inputChecks" : "outputChecks"]++;
      dependencies(step.contract_ref, phase as "input" | "output");
    }
    if (phases.length) {
      const parameter = list(step.parameters).find((entry) => Array.isArray(entry) && entry[0] === "policy_id");
      if (Array.isArray(parameter) && typeof parameter[1] === "string") coveredPolicies.add(parameter[1]);
    }
  }
  // Programmable Policies can execute native NeMo flows without product steps.
  // Count only enabled flows, and never presume arbitrary actions are model-free.
  for (const value of list(plan.policy_versions)) {
    const policy = record(value);
    if (typeof policy.policy_id !== "string") continue;
    const representedBySteps = coveredPolicies.has(policy.policy_id);
    const bound = plan.policy_bindings.map(record).find((binding) => binding.policy_id === policy.policy_id
      && String(binding.policy_version) === String(policy.version));
    if (!bound) continue;
    for (const value of list(policy.rail_bindings)) {
      const rail = record(value);
      if ((rail.rail_type !== "input" && rail.rail_type !== "output") || typeof rail.flow_name !== "string") continue;
      if ((list(bound.enabled_rails).length > 0 && !list(bound.enabled_rails).includes(rail.rail_type))
        || !list(bound.enabled_rule_ids).includes(flowRuleId(rail.rail_type, rail.flow_name))) continue;
      if (!representedBySteps) coverage[rail.rail_type === "input" ? "inputChecks" : "outputChecks"]++;
      coveredPolicies.add(policy.policy_id);
      coverage.hasUnknownDependencies = true;
      for (const contract of list(policy.evaluation_contracts)) dependencies(contract, rail.rail_type);
    }
  }
  coverage.policyCount = new Set(plan.policy_bindings.map(record)
    .map((binding) => binding.policy_id).filter((id) => typeof id === "string" && coveredPolicies.has(id))).size;
  coverage.requiredModelBindings = [...required];
  return coverage;
}

export function isModelIndependent(coverage: ProtectionCoverage | null): boolean | null {
  if (!coverage || !coverage.inputChecks && !coverage.outputChecks) return null;
  if (coverage.requiredModelBindings.length) return false;
  return coverage.hasUnknownDependencies ? null : true;
}
