import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { protectionPresets } from "../../shared/protection-presets.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { exportProfilePackage, importProfilePackage } from "./profile-package.js";

const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
const profile = protectionPresets[0]!;

describe("target Profile package", () => {
  it("round-trips a Profile with pinned Policy and Rule identities", () => {
    const packageValue = exportProfilePackage(profile, policies);
    expect(importProfilePackage(structuredClone(packageValue), policies)).toEqual(profile);
    expect(packageValue.policies).toHaveLength(profile.policies.length);
    expect(packageValue.policies.every(item => item.checksum.length === 64 && item.rules.length > 0)).toBe(true);
  });

  it("rejects stale scope references even when Policy checksums are valid", () => {
    const value = exportProfilePackage(profile, policies);
    value.profile.testExclusions![0]!.policyVersion = "9.9.9";
    expect(() => importProfilePackage(value, policies)).toThrow("invalid test exclusion");
  });

  it("rejects a tampered Policy checksum or unknown Policy", () => {
    const packageValue = exportProfilePackage(profile, policies);
    const tampered = structuredClone(packageValue);
    tampered.policies[0]!.checksum = "0".repeat(64);
    expect(() => importProfilePackage(tampered, policies)).toThrow(/checksum mismatch/);
    const missing = structuredClone(packageValue);
    missing.policies[0]!.version = "9.9.9";
    expect(() => importProfilePackage(missing, policies)).toThrow(/unavailable/);
  });
});
