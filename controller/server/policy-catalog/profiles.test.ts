import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { protectionPresets } from "../../shared/protection-presets.js";
import { expandProtectionPreset, profileRequiresModels, profileExcludedCaseIds } from "./presets.js";
import { PolicyCatalog } from "./catalog.js";

const policyView = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();

describe("Target Profile baseline", () => {
  it("has the five approved Profiles", () => {
    expect(protectionPresets.map(profile => profile.id)).toEqual([
      "default", "full-feature", "sg-bank", "cn-financial-services", "cn-internet",
    ]);
  });

  it("Default is local-only and Full-feature covers every catalog Rule", () => {
    const byId = new Map(protectionPresets.map(profile => [profile.id, profile]));
    const local = expandProtectionPreset(byId.get("default")!, policyView);
    expect(local.some(binding => ["pii-semantic", "content-safety-model", "answer-reliability"].includes(binding.policyId))).toBe(false);
    expect(profileRequiresModels(byId.get("default")!, policyView)).toBe(false);

    const full = expandProtectionPreset(byId.get("full-feature")!, policyView);
    expect(full).toHaveLength(20);
    expect(full.reduce((count, binding) => count + binding.enabledRuleIds.length, 0)).toBe(198);
    expect(profileRequiresModels(byId.get("full-feature")!, policyView)).toBe(true);
  });

  it("validates pinned exclusions and applies them only to matching source cases", () => {
    const profile = structuredClone(protectionPresets.find(p => p.id === "default")!);
    const binding = profile.policies.find(p => p.policyId === "payment-data")!;
    const source = policyView.find(p => p.id === binding.policyId)!.test_cases[0]!;
    profile.testExclusions = [{ policyId: binding.policyId, policyVersion: binding.policyVersion, sourceCaseId: source.id, reason: "Overlapping composition contract." }];
    expect(() => expandProtectionPreset(profile, policyView)).not.toThrow();
    const test = { id: "instance-case", sourcePolicyId: binding.policyId, sourcePolicyVersion: binding.policyVersion, sourceCaseId: source.id };
    expect(profileExcludedCaseIds(profile, [test, { ...test, id: "other", sourcePolicyVersion: "different" }])).toEqual([test.id]);
    profile.testExclusions[0]!.reason = " ";
    expect(() => expandProtectionPreset(profile, policyView)).toThrow("invalid test exclusion");
    profile.testExclusions[0]!.reason = "Reviewed";
    profile.testExclusions[0]!.sourceCaseId = "missing";
    expect(() => expandProtectionPreset(profile, policyView)).toThrow("invalid test exclusion");
  });

  it("exposes only the compiled catalog", () => {
    const catalog = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets"));
    expect(catalog.list()).toHaveLength(21);
    expect(catalog.list().some(policy => policy.id === "local-contact-data")).toBe(false);
    expect(catalog.get("payment-data")?.id).toBe("payment-data");
    expect(catalog.get("local-contact-data")).toBeUndefined();
  });

  it("industry Profiles use their regional compliance selection", () => {
    const byId = new Map(protectionPresets.map(profile => [profile.id, profile]));
    const sg = expandProtectionPreset(byId.get("sg-bank")!, policyView);
    expect(sg.map(binding => binding.policyId)).toContain("regional-compliance-sg-pdpa");
    const cn = expandProtectionPreset(byId.get("cn-financial-services")!, policyView);
    expect(cn.map(binding => binding.policyId)).not.toContain("regional-compliance-sg-pdpa");
    expect(cn.map(binding => binding.policyId)).toContain("financial-market-misconduct");
  });

  it("keeps the protection map, framework and jurisdiction classification", () => {
    const values = (id: string, namespace: string) => policyView.find(policy => policy.id === id)!
      .tags.filter(tag => tag.namespace === namespace).map(tag => tag.value).sort();
    const facet = (namespace: string) => [...new Set(policyView.flatMap(policy => policy.tags
      .filter(tag => tag.namespace === namespace).map(tag => tag.value)))].sort();
    // Every catalog Policy stays navigable from the protection map.
    expect(policyView.every(policy => policy.tags.some(tag => tag.namespace === "protection"))).toBe(true);
    // The Library's two compliance facets are populated, not just the protection map.
    expect(facet("framework")).toEqual(["eu-ai-act", "gdpr", "jr-t-0221-2021", "owasp-llm-2025", "pdpa", "pipl-cn"]);
    expect(facet("jurisdiction")).toEqual(["au", "cn", "eu", "sg", "uae"]);
    // A catalog Policy inherits the frameworks and regions its source Policies declare.
    expect(values("contact-data", "framework")).toEqual(["gdpr", "owasp-llm-2025", "pdpa", "pipl-cn"]);
    expect(values("payment-data", "framework")).toEqual(["gdpr", "owasp-llm-2025", "pdpa", "pipl-cn"]);
    expect(values("regional-compliance-eu-ai-act", "framework")).toEqual(["eu-ai-act"]);
    expect(values("regional-compliance-sg-pdpa", "framework")).toEqual(["owasp-llm-2025", "pdpa"]);
    expect(values("financial-market-misconduct", "framework")).toEqual(["jr-t-0221-2021", "owasp-llm-2025"]);
    // Regions stay case-specific: only Policies covering a region declare it.
    expect(values("contact-data", "jurisdiction")).toEqual(["au", "cn", "eu", "sg", "uae"]);
    expect(values("regional-compliance-eu-ai-act", "jurisdiction")).toEqual(["eu"]);
    expect(values("regional-compliance-sg-pdpa", "jurisdiction")).toEqual(["sg"]);
    expect(values("answer-reliability", "jurisdiction")).toEqual([]);
    expect(values("answer-reliability", "framework")).toEqual(["owasp-llm-2025"]);
  });
});
