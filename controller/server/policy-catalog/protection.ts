import { protectionDirectoryIds, type PolicyProtection, type ProtectionDirectoryId } from "../../shared/protection-map.js";
import { z } from "zod";

export const protectionContractsSchema = z.object({
  version: z.string().min(1),
  directories: z.array(z.enum(protectionDirectoryIds)),
  nativePolicies: z.record(z.string(), z.object({
    capability: z.string().min(1),
    rails: z.array(z.enum(["input", "output"])).min(1),
    modelCapabilities: z.array(z.string()),
    requiredContext: z.array(z.string()),
    execution: z.enum(["local", "model", "local_then_model"]),
    outputStreaming: z.enum(["not_applicable", "incremental_check", "complete_response"]),
  })),
});
export type ProtectionContracts = z.output<typeof protectionContractsSchema>;

type PolicySurface = {
  id: string;
  rails: readonly string[];
  rules: ReadonlyArray<{ form: string; implementation: { binding_id: string } }>;
  tags: ReadonlyArray<{ namespace: string; value: string }>;
};

/** Read declared business ownership; legacy categories are not business folders. */
export function policyProtection(policy: PolicySurface, contracts: ProtectionContracts): PolicyProtection {
  const declared = policy.tags.filter((tag) => tag.namespace === "protection").map((tag) => tag.value);
  if (declared.length !== 1 || !protectionDirectoryIds.includes(declared[0] as ProtectionDirectoryId)) {
    throw new Error(`Policy ${policy.id} must declare exactly one valid protection directory.`);
  }
  const native = contracts.nativePolicies[policy.id];
  if (native && policy.rails.some((rail) => !(native.rails as string[]).includes(rail))) {
    throw new Error(`Policy ${policy.id} declares a Rail outside its runtime contract.`);
  }
  const unknownFlow = policy.rules.some((rule) => rule.form === "colang_flow") && !native;
  const execution = native?.execution ?? (unknownFlow ? "custom" : "local");
  const model = Boolean(native?.modelCapabilities.length);
  return {
    directory: declared[0] as ProtectionDirectoryId,
    execution,
    modelCapabilities: [...(native?.modelCapabilities ?? [])],
    requiredContext: [...(native?.requiredContext ?? [])],
    outputStreaming: !policy.rails.includes("output") ? "not_applicable"
      : native?.outputStreaming ?? "complete_response",
    limitations: [
      ...(execution === "local" ? ["Matches configured local patterns; it does not provide comprehensive semantic detection."] : []),
      ...(model ? ["Requires a compatible, validated runtime assignment; model callability alone is not validation."] : []),
      ...(policy.id === "builtin-content-safety" ? ["Incremental checks cannot recall previously released text. Transforming actions require a complete response."] : []),
      ...(declared[0] === "business_rules" ? ["Screens text against configured business rules; it does not establish regulatory compliance or authorize actions."] : []),
      ...(declared[0] === "application_injection" ? ["Content screening does not replace parameterized queries, output encoding, sandboxing or tool authorization."] : []),
    ],
  };
}
