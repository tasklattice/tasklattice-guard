import { protectionPresets } from "./protection-presets.js";
import type { GuardrailProfile } from "./protection-map.js";

// Seed data only. Runtime requests read guardrail_profile, never this array.
export const defaultGuardrailProfiles: readonly GuardrailProfile[] = protectionPresets.map(profile => ({
  ...profile,
  category: profile.jurisdictions.includes("singapore") ? "singapore_finance" : profile.industry,
  categoryName: profile.jurisdictions.includes("singapore") ? "Singapore finance" : ({
    general: "General", banking: "Banking", securities: "Securities", internet: "Internet support",
  }[profile.industry]),
  isDefault: true,
}));
