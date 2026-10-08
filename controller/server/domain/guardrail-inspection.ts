import { createHash } from "node:crypto";
import { canonicalJson } from "../../shared/canonical-json.js";
import type { PolicyDto } from "../policy-catalog/catalog.js";
import { flowRuleId, type ProgrammablePolicySnapshot } from "../policy-studio/model.js";
import type { GuardrailDraftConfig } from "./guardrail-plan.js";

/**
 * Read-only description frozen with a tested candidate. It travels with the
 * version so another environment can show what the version contains without
 * a Policy Library. It never feeds back into execution.
 */
export type GuardrailInspection = {
  name: string;
  runtimeProfile: string;
  draftConfig: GuardrailDraftConfig;
  policies: Array<{
    policyId: string;
    policyVersion: string;
    name: string;
    source: "built_in" | "custom";
    rules: Array<{ id: string; name: string; action: string | null }>;
  }>;
  testSuite: { total: number; digest: string };
};

export function testSuiteDigest(cases: unknown[]): string {
  return createHash("sha256").update(canonicalJson(cases)).digest("hex");
}

export function guardrailInspection(input: {
  name: string;
  runtimeProfile: string;
  draftConfig: GuardrailDraftConfig;
  catalog: PolicyDto[];
  programmablePolicies: ProgrammablePolicySnapshot[];
  testCases: unknown[];
}): GuardrailInspection {
  const builtIn = new Map(input.catalog.map(policy => [`${policy.id}@${policy.version}`, policy]));
  const custom = new Map(input.programmablePolicies.map(policy => [`${policy.policy_id}@${policy.version}`, policy]));
  return {
    name: input.name,
    runtimeProfile: input.runtimeProfile,
    draftConfig: input.draftConfig,
    policies: input.draftConfig.policyBindings.map(binding => {
      const key = `${binding.policyId}@${binding.policyVersion}`;
      const enabled = new Set(binding.enabledRuleIds);
      const catalogPolicy = builtIn.get(key) ?? input.catalog.find(policy => policy.id === binding.policyId);
      if (catalogPolicy) {
        return {
          policyId: binding.policyId, policyVersion: binding.policyVersion, name: catalogPolicy.name, source: catalogPolicy.source,
          rules: catalogPolicy.rules.filter(rule => !enabled.size || enabled.has(rule.id))
            .map(rule => ({ id: rule.id, name: rule.name, action: binding.ruleActions[rule.id] ?? binding.action ?? rule.effect })),
        };
      }
      const programmable = custom.get(key);
      return {
        policyId: binding.policyId, policyVersion: binding.policyVersion, name: programmable?.name ?? binding.policyId, source: "custom" as const,
        rules: (programmable?.rail_bindings ?? []).map(flow => {
          const id = flowRuleId(flow.rail_type, flow.flow_name);
          return { id, name: flow.flow_name, action: binding.ruleActions[id] ?? binding.action ?? flow.on_unsafe };
        }),
      };
    }),
    testSuite: { total: input.testCases.length, digest: testSuiteDigest(input.testCases) },
  };
}
