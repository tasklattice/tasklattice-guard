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
    expect(full).toHaveLength(19);
    expect(full.reduce((count, binding) => count + binding.enabledRuleIds.length, 0)).toBe(197);
    expect(profileRequiresModels(byId.get("full-feature")!, policyView)).toBe(true);
  });

  it("keeps legacy Policies readable without exposing them in the active list", () => {
    const catalog = PolicyCatalog.load(
      resolve("../runner/toolkit/policy_library/assets_target"),
      resolve("../runner/toolkit/policy_library/assets"),
    );
    expect(catalog.list()).toHaveLength(20);
    expect(catalog.list().some(policy => policy.id === "local-contact-data")).toBe(false);
    expect(catalog.get("local-contact-data")?.id).toBe("local-contact-data");
    expect(catalog.isLegacy("local-contact-data")).toBe(true);
    expect(catalog.isLegacy("payment-data")).toBe(false);
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
