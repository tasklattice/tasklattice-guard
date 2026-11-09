import { capabilityBindingDefinitions, type ImplementedGuardrailRailType } from "./guardrail-catalog.js";

/** Registered local evaluator contracts, shared by setup, catalog and health. */
export const localGuardrailContracts = [
  "tali.guard.secrets.exact.v1",
  "tali.guard.pii.exact.v1",
  "tali.guard.content-filter.rules.v1",
  "tali.guard.prompt-injection.v1",
  "tali.guard.indirect-prompt-injection.v1",
  "tali.guard.memory-poisoning.v1",
  "tali.guard.system-prompt-leakage.v1",
  "tali.guard.topic-control.rules.v1",
] as const;

/** A known contract is a dependency fact, never proof of callability/quality.
 * Callers inspecting arbitrary Colang must additionally retain unknown=true:
 * declarations are a lower bound, not a complete static source analysis. */
export function evaluationContractDependencies(contract: unknown, rail: ImplementedGuardrailRailType) {
  if (typeof contract !== "string") return { bindings: [], unknown: true };
  if ((localGuardrailContracts as readonly string[]).includes(contract)) return { bindings: [], unknown: false };
  const bindings = capabilityBindingDefinitions.filter(item => item.railType === rail && item.contractRefs.includes(contract));
  return { bindings, unknown: !bindings.length };
}
