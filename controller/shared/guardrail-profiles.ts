import type { GuardrailProfile } from "./protection-map.js";
import { protectionPresets } from "./protection-presets.js";

// The seeded Profile catalog. Runtime requests read enabled database rows.
export const guardrailProfiles: readonly GuardrailProfile[] = protectionPresets.map(profile => ({
  ...profile,
  category: profile.benchmarkOnly ? "catalog_benchmark" : `catalog_${profile.id.replaceAll("-", "_")}`,
  categoryName: profile.benchmarkOnly ? "Benchmark" : profile.name,
  // The shipped catalog baseline is the platform default; benchmark and industry
  // Profiles are alternatives, not extra defaults.
  isDefault: profile.id === "default",
}));
