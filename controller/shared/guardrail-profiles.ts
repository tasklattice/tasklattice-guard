import { protectionPresets } from "./protection-presets.js";
import type { GuardrailProfile } from "./protection-map.js";
import { localBaseline } from "./local-baseline.js";
import { fullFeatureBaseline } from "./full-feature-baseline.js";
import { targetProtectionPresets } from "./target-protection-presets.js";

function industryProfile(id: string, name: string, category: string, categoryName: string): GuardrailProfile {
  const profile = protectionPresets.find(item => item.id === id);
  if (!profile) throw new Error(`Missing built-in Profile ${id}`);
  return { ...profile, name, category, categoryName, isDefault: true };
}

// The curated seed catalog. Runtime requests read enabled database rows.
export const defaultGuardrailProfiles: readonly GuardrailProfile[] = [
  localBaseline,
  fullFeatureBaseline,
  industryProfile("banking-assistant", "Bank", "banking", "Bank"),
  industryProfile("securities-assistant", "Securities & brokerage", "securities", "Securities"),
  industryProfile("internet-customer-support", "Internet platform support", "internet", "Internet support"),
];


// Opt-in target baseline. Selected by CONTROLLER_POLICY_CATALOG_MODE=target.
export const targetGuardrailProfiles: readonly GuardrailProfile[] = targetProtectionPresets.map(profile => ({
  ...profile,
  category: profile.benchmarkOnly ? "target_benchmark" : `target_${profile.id.replaceAll("-", "_")}`,
  categoryName: profile.benchmarkOnly ? "Benchmark" : profile.name,
  isDefault: true,
}));
