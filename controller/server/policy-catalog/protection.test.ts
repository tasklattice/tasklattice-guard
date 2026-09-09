import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { protectionDirectoryIds } from "../../shared/protection-map.js";
import { capabilityBindingDefinitions } from "../../shared/guardrail-catalog.js";
import { PolicyCatalog } from "./catalog.js";
import { policyProtection, protectionContractsSchema } from "./protection.js";

const directory = resolve("../runner/toolkit/policy_library/assets");
const contracts = protectionContractsSchema.parse(JSON.parse(readFileSync(resolve(directory, "protection-contracts.json"), "utf8")));
const catalog = PolicyCatalog.load(directory);

describe("Protection contract", () => {
  it("gives every Policy exactly one business directory, independently of provider protocols", () => {
    expect(contracts.directories).toEqual(protectionDirectoryIds);
    for (const policy of catalog.list()) {
      expect(protectionDirectoryIds).toContain(policy.protection.directory);
      expect(policy.tags.filter((tag) => tag.namespace === "protection")).toHaveLength(1);
      if (policy.protection.execution === "local") expect(policy.protection.modelCapabilities).toEqual([]);
    }
  });

  it("does not invent an Output jailbreak or topic binding and keeps grounded output contextual", () => {
    expect(catalog.get("builtin-jailbreak")?.protection.outputStreaming).toBe("not_applicable");
    expect(catalog.get("builtin-topic-safety")?.protection.requiredContext).toEqual(["allowed_topics"]);
    expect(catalog.get("builtin-contextual-grounding")?.protection).toMatchObject({
      requiredContext: ["query", "grounding_source"], outputStreaming: "complete_response",
    });
    for (const native of Object.values(contracts.nativePolicies)) {
      for (const capability of native.modelCapabilities) {
        for (const rail of native.rails) {
          expect(capabilityBindingDefinitions.some((binding) => binding.capabilityRef === capability && binding.railType === rail)).toBe(true);
        }
      }
    }
  });

  it("rejects ambiguous ownership and unsupported runtime directions", () => {
    const policy = structuredClone(catalog.get("builtin-jailbreak")!);
    expect(() => policyProtection({ ...policy, tags: [] }, contracts)).toThrow(/exactly one/);
    expect(() => policyProtection({ ...policy, tags: [...policy.tags, { namespace: "protection", value: "privacy" }] }, contracts)).toThrow(/exactly one/);
    expect(() => policyProtection({ ...policy, rails: ["output"] }, contracts)).toThrow(/outside its runtime contract/);
  });

});
