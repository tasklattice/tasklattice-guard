// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { PolicyDto } from "../policy-catalog/catalog.js";
import type { ProgrammablePolicySnapshot } from "../policy-studio/model.js";
import { derivesFromCatalogNode, frozenBuiltInDefinition, guardrailPolicyNodes, policyNodeDigest } from "./policy-node.js";

const rule = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, effect: "block", rails: ["input"], detector: { ref: "text/regex", version: "1" }, ...extra });
const node = {
  id: "phrases", name: "Phrases", description: "", source: "built_in", version: "1.0.0", tags: [], parameters: [{ name: "entries" }],
  rules: [rule("phrase/entries", { rule_expansion: { parameter: "entries" } }), rule("pattern/fixed")],
  test_cases: [{ id: "t1", name: "Blocks", content: "x", covered_rule_ids: ["phrase/entries"] }],
  safety_level: "balanced", output_delivery: "full_buffered",
};

describe("Policy nodes", () => {
  it("accepts an Artifact copy whose phrase Rule expanded per binding, and nothing else", () => {
    const expanded = { ...node,
      rules: [rule("phrase/entries/1", { name: "alpha" }), rule("phrase/entries/2", { name: "beta" }), rule("pattern/fixed")],
      test_cases: [{ id: "t1", name: "Blocks", content: "x", covered_rule_ids: ["phrase/entries/1", "phrase/entries/2"] }] };
    expect(derivesFromCatalogNode(node, expanded)).toBe(true);
    expect(derivesFromCatalogNode(node, { ...expanded, description: "changed" })).toBe(false);
    expect(derivesFromCatalogNode(node, { ...expanded, rules: [...expanded.rules.slice(0, 2), rule("pattern/fixed", { effect: "allow" })] })).toBe(false);
    expect(derivesFromCatalogNode(node, { ...expanded, rules: expanded.rules.slice(0, 2) })).toBe(false);
    expect(derivesFromCatalogNode(node, { ...expanded, rules: [...expanded.rules, rule("other/rule")] })).toBe(false);
  });

  it("takes catalog versions before expansion and Policy Studio versions as their snapshots, once each", () => {
    const catalogPolicy = { ...node, tags: [{ id: "x:y", namespace: "x", value: "y", label: "Y", source: "declared" }], published_versions: [{ ...node, version: "0.9.0" }] } as unknown as PolicyDto;
    const snapshot = { policy_id: "studio", version: "2", checksum: "c" } as unknown as ProgrammablePolicySnapshot;
    const nodes = guardrailPolicyNodes([
      { policyId: "phrases", policyVersion: "0.9.0" }, { policyId: "studio", policyVersion: "2" }, { policyId: "phrases", policyVersion: "0.9.0" },
    ], [catalogPolicy], [snapshot]);
    expect(nodes.map(item => [item.id, item.version, item.kind])).toEqual([["phrases", "0.9.0", "catalog"], ["studio", "2", "programmable"]]);
    expect(nodes[0]!.definition).toEqual(frozenBuiltInDefinition({ ...node, version: "0.9.0" } as unknown as PolicyDto));
    expect(nodes[1]!.definition).toBe(snapshot);
    // Identity is the definition alone.
    expect(policyNodeDigest(nodes[0]!.definition)).toBe(policyNodeDigest(JSON.parse(JSON.stringify(nodes[0]!.definition))));
  });
});
