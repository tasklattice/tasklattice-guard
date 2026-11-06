import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { targetProtectionPresets } from "../../shared/target-protection-presets.js";
import { expandProtectionPreset, profileRequiresModels } from "./presets.js";
import { PolicyCatalog } from "./catalog.js";

const policyView = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets_target")).list();

describe("Target Profile baseline", () => {
  it("has the five approved Profiles", () => {
    expect(targetProtectionPresets.map(profile => profile.id)).toEqual([
      "default", "full-feature", "sg-bank", "cn-financial-services", "cn-internet",
    ]);
  });

  it("Default is local-only and Full-feature covers every target Rule", () => {
    const byId = new Map(targetProtectionPresets.map(profile => [profile.id, profile]));
    const local = expandProtectionPreset(byId.get("default")!, policyView);
    expect(local.some(binding => ["pii-semantic", "content-safety-model", "answer-reliability"].includes(binding.policyId))).toBe(false);
    expect(profileRequiresModels(byId.get("default")!, policyView)).toBe(false);

    const full = expandProtectionPreset(byId.get("full-feature")!, policyView);
    expect(full).toHaveLength(20);
    expect(full.reduce((count, binding) => count + binding.enabledRuleIds.length, 0)).toBe(207);
    expect(profileRequiresModels(byId.get("full-feature")!, policyView)).toBe(true);
  });

  it("industry Profiles use their regional compliance selection", () => {
    const byId = new Map(targetProtectionPresets.map(profile => [profile.id, profile]));
    const sg = expandProtectionPreset(byId.get("sg-bank")!, policyView);
    expect(sg.map(binding => binding.policyId)).toContain("regional-compliance-sg-pdpa");
    const cn = expandProtectionPreset(byId.get("cn-financial-services")!, policyView);
    expect(cn.map(binding => binding.policyId)).not.toContain("regional-compliance-sg-pdpa");
    expect(cn.map(binding => binding.policyId)).toContain("financial-market-misconduct");
  });
});
