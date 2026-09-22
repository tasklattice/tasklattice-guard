import { protectionPresets } from "./protection-presets.js";
import type { GuardrailProfile } from "./protection-map.js";

// Seed data only. Runtime requests read guardrail_profile, never this array.
export const defaultGuardrailProfiles: readonly GuardrailProfile[] = protectionPresets.map(profile => {
  const singapore = profile.jurisdictions.includes("singapore");
  const china = profile.jurisdictions.includes("cn");
  const category = singapore ? "singapore_finance" : china
    ? profile.industry === "banking" ? "china_banking" : "china_mainland"
    : profile.industry;
  const categoryName = singapore ? "Singapore finance" : china
    ? profile.industry === "banking" ? "China mainland banking" : "China mainland"
    : ({ general: "General", banking: "Banking", securities: "Securities", internet: "Internet support" }[profile.industry]);
  return { ...profile, category, categoryName, isDefault: true };
});
