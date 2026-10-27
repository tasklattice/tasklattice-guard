import { protectionPresets } from "./protection-presets.js";
import type { GuardrailProfile } from "./protection-map.js";
import { localBaseline } from "./local-baseline.js";
import { fullFeatureBaseline } from "./full-feature-baseline.js";

function industryProfile(id: string, name: string, category: string, categoryName: string): GuardrailProfile {
  const profile = protectionPresets.find(item => item.id === id);
  if (!profile) throw new Error(`Missing built-in Profile ${id}`);
  return { ...profile, name, category, categoryName, isDefault: true };
}

// The curated seed catalog. Runtime requests read enabled database rows.
// Historical compositions remain available to artifact fixtures, not discovery.
export const defaultGuardrailProfiles: readonly GuardrailProfile[] = [
  localBaseline,
  fullFeatureBaseline,
  industryProfile("banking-assistant", "Bank", "banking", "Bank"),
  industryProfile("securities-assistant", "Securities & brokerage", "securities", "Securities"),
  industryProfile("internet-customer-support", "Internet platform support", "internet", "Internet support"),
];
