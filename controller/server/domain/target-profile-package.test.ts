import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { targetProtectionPresets } from "../../shared/target-protection-presets.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { exportTargetProfilePackage, importTargetProfilePackage } from "./target-profile-package.js";

const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets_target")).list();
const profile = targetProtectionPresets[0]!;

describe("target Profile package", () => {
  it("round-trips a Profile with pinned Policy and Rule identities", () => {
    const packageValue = exportTargetProfilePackage(profile, policies);
    expect(importTargetProfilePackage(structuredClone(packageValue), policies)).toEqual(profile);
    expect(packageValue.policies).toHaveLength(profile.policies.length);
    expect(packageValue.policies.every(item => item.checksum.length === 64 && item.rules.length > 0)).toBe(true);
  });

  it("rejects a tampered Policy checksum or unknown Policy", () => {
    const packageValue = exportTargetProfilePackage(profile, policies);
    const tampered = structuredClone(packageValue);
    tampered.policies[0]!.checksum = "0".repeat(64);
    expect(() => importTargetProfilePackage(tampered, policies)).toThrow(/checksum mismatch/);
    const missing = structuredClone(packageValue);
    missing.policies[0]!.version = "9.9.9";
    expect(() => importTargetProfilePackage(missing, policies)).toThrow(/unavailable/);
  });
});
