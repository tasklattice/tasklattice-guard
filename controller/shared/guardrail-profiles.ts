import { protectionPresets } from "./protection-presets.js";
import type { GuardrailProfile } from "./protection-map.js";
import { localBaseline } from "./local-baseline.js";
import { fullFeatureBaseline } from "./full-feature-baseline.js";

const useCaseCategories: Record<string, [string, string]> = {
  "multilingual-content-safety": ["multilingual_content", "Multilingual content"],
  "claims-assistant": ["claims", "Claims support"],
  "eu-high-risk-practices": ["eu_high_risk", "EU high-risk practices"],
};

// Seed data only. Runtime requests read guardrail_profile, never this array.
export const defaultGuardrailProfiles: readonly GuardrailProfile[] = [...protectionPresets.map(profile => {
  const singapore = profile.jurisdictions.includes("singapore");
  const region = profile.jurisdictions[0];
  const china = profile.jurisdictions.includes("cn");
  const category = singapore ? (profile.industry === "banking" ? "singapore_finance" : "singapore") : china
    ? profile.industry === "banking" ? "china_banking" : "china_mainland"
    : region ?? profile.industry;
  const categoryName = singapore ? (profile.industry === "banking" ? "Singapore finance" : "Singapore") : china
    ? profile.industry === "banking" ? "China mainland banking" : "China mainland"
    : ({ au: "Australia", eu: "European Union", uae: "UAE" }[region ?? ""] ?? ({ general: "General", banking: "Banking", securities: "Securities", internet: "Internet support" }[profile.industry]));
  const useCase = useCaseCategories[profile.id];
  return { ...profile, category: useCase?.[0] ?? category, categoryName: useCase?.[1] ?? categoryName, isDefault: true };
}), fullFeatureBaseline, localBaseline];
