import { guardrailProfiles } from "../../shared/guardrail-profiles.js";
import type { GuardrailDraftConfig } from "./guardrail-plan.js";
import type { PolicyDto } from "../policy-catalog/catalog.js";
import { profileDraft } from "../policy-catalog/presets.js";

/** The reviewed platform starting configuration every project begins from. */
export const platformDefaultProfile = guardrailProfiles.find(profile => profile.id === "default")
  ?? (() => { throw new Error("The target Default Profile is missing from the seed catalog."); })();

/** The platform Default Guardrail is exactly the target Default Profile's selection. */
export function platformDefaultDraft(policies: readonly PolicyDto[]): GuardrailDraftConfig {
  const draft = profileDraft(platformDefaultProfile, policies);
  for (const binding of draft.policyBindings) {
    const policy = policies.find(item => item.id === binding.policyId && item.version === binding.policyVersion);
    if (!policy) throw new Error(`Default Guardrail Policy ${binding.policyId} is missing from the catalog.`);
    for (const ruleId of binding.enabledRuleIds) {
      const rule = policy.rules.find(item => item.id === ruleId);
      if (!rule) throw new Error(`Default Guardrail Policy ${policy.id} is missing Rule ${ruleId}.`);
      if (!["local", "platform"].includes(rule.implementation.execution)) {
        throw new Error(`Default Guardrail Policy ${policy.id} Rule ${ruleId} must use a verified local implementation.`);
      }
    }
  }
  return draft;
}
