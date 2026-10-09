// @vitest-environment node
import { describe, expect, it } from "vitest";
import { aggregateReleasedPolicies, type ReleasedGuardrailVersion } from "./released-policies.js";

/** A plan with one frozen built-in definition and one custom Policy version. */
function plan(builtin: { version: string; name: string; rules?: string[] }, custom?: { version: string; name: string; checksum: string }) {
  const definition = { id: "local-network-addresses", name: builtin.name, description: "Addresses", source: "built_in", version: builtin.version,
    tags: [{ namespace: "protection", value: "privacy", label: "Privacy", source: "declared" }],
    rules: (builtin.rules ?? ["pattern/ipv4", "pattern/url"]).map(id => ({ id, name: id.toUpperCase(), effect: "transform", rails: ["output", "input"], detector: { ref: "pattern/regex", version: "1" } })),
    test_cases: [{ id: "case-1", name: "IPv4", content: "10.0.0.1", expected_decision: "transform" }] };
  return {
    steps: [{ capability: "builtin_content_filter", parameters: [["policy_definitions_json", JSON.stringify({ "local-network-addresses": definition })]] }],
    policy_versions: custom ? [{ policy_id: "policy-123", version: custom.version, name: custom.name, checksum: custom.checksum, colang_version: "2.x",
      rail_bindings: [{ rail_type: "input", flow_name: "marker_input", on_unsafe: "block" }], test_cases: [["Blocks the marker", "block"]],
      execution_contract: [["output_delivery", "full_buffered"]] }] : [],
    policy_bindings: [
      { policy_id: "local-network-addresses", policy_version: builtin.version, enabled_rule_ids: ["pattern/ipv4"], action: null, enabled_rails: ["input"] },
      ...(custom ? [{ policy_id: "policy-123", policy_version: custom.version, enabled_rule_ids: ["flow/input/marker_input"], action: "block", enabled_rails: ["input"] }] : []),
    ],
  };
}
const row = (guardrailId: string, guardrailVersion: string, value: Record<string, unknown>, extra: Partial<ReleasedGuardrailVersion> = {}): ReleasedGuardrailVersion => ({
  guardrailId, guardrailName: `Guardrail ${guardrailId}`, guardrailVersion, origin: "imported", sourceId: "bank-uat", serving: false, plan: value, ...extra,
});

describe("released Policies", () => {
  it("groups by Policy ID and lists which Guardrail versions use each Policy version", () => {
    const policies = aggregateReleasedPolicies([
      row("a", "20261008-100000.000Z", plan({ version: "2.0.0", name: "Network addresses" }, { version: "1", name: "Marker", checksum: "c1" }), { serving: true }),
      row("b", "20261008-110000.000Z", plan({ version: "1.4.0", name: "Network addresses (legacy)" }, { version: "2", name: "Marker v2", checksum: "c2" })),
    ]);
    expect(policies.map(policy => policy.policyId).sort()).toEqual(["local-network-addresses", "policy-123"]);
    const network = policies.find(policy => policy.policyId === "local-network-addresses")!;
    // The version serving traffic comes first and names the Policy.
    expect(network.versions.map(version => version.version)).toEqual(["2.0.0", "1.4.0"]);
    expect(network.name).toBe("Network addresses");
    expect(network.serving).toBe(true);
    expect(network.versions[1]).toMatchObject({ name: "Network addresses (legacy)", usage: [{ guardrailId: "b", serving: false, enabledRuleIds: ["pattern/ipv4"] }] });
    expect(network.versions[0]!.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    // The frozen definition comes back in the shape a Policy Library lists.
    expect(network.versions[0]!.definition).toMatchObject({
      implementation: "rules", id: "local-network-addresses", version: "2.0.0", rails: ["input", "output"], effects: ["transform"], detectors: ["pattern/regex"],
      tags: [{ id: "protection:privacy", namespace: "protection", value: "privacy" }], test_count: 1,
    });
    expect(network.versions[0]!.definition.rules.map(rule => rule.id)).toEqual(["pattern/ipv4", "pattern/url"]);
    const custom = policies.find(policy => policy.policyId === "policy-123")!;
    expect(custom).toMatchObject({ source: "custom", name: "Marker" });
    expect(custom.versions.map(version => [version.version, version.contentDigest])).toEqual([["1", "c1"], ["2", "c2"]]);
    expect(custom.versions[0]!.definition).toMatchObject({
      implementation: "nemo_native", source: "custom", version: "1", rails: ["input"], effects: ["block"], output_delivery: "full_buffered",
      rules: [{ id: "flow/input/marker_input", name: "Marker Input", effect: "block", rails: ["input"], detector: { ref: "programmable/marker_input", version: "1" } }],
      // A release keeps test names and expected decisions, never test inputs.
      test_cases: [{ name: "Blocks the marker", expected_decision: "block", content: "" }], test_count: 1,
      tags: [{ id: "implementation:colang-2.x" }, { id: "rail:input" }],
    });
  });

  it("merges identical content used by several Guardrails into one Policy version", () => {
    const same = plan({ version: "2.0.0", name: "Network addresses" });
    const [policy] = aggregateReleasedPolicies([row("a", "20261008-100000.000Z", same), row("b", "20261008-110000.000Z", structuredClone(same))]);
    expect(policy!.versions).toHaveLength(1);
    expect(policy!.versions[0]!.usage.map(item => item.guardrailId)).toEqual(["b", "a"]);
    expect(policy!.conflictingVersions).toEqual([]);
  });

  it("never merges one version number released with different content", () => {
    const policies = aggregateReleasedPolicies([
      row("a", "20261008-100000.000Z", plan({ version: "2.0.0", name: "Network addresses" }), { sourceId: "bank-uat" }),
      row("b", "20261008-110000.000Z", plan({ version: "2.0.0", name: "Network addresses", rules: ["pattern/ipv4"] }), { sourceId: "bank-uat-b" }),
    ]);
    const [policy] = policies;
    expect(policy!.versions).toHaveLength(2);
    expect(new Set(policy!.versions.map(version => version.contentDigest)).size).toBe(2);
    expect(policy!.conflictingVersions).toEqual(["2.0.0"]);
  });

  it("keeps a binding visible even when its plan carries no frozen definition", () => {
    const [policy] = aggregateReleasedPolicies([row("a", "20261008-100000.000Z", { policy_bindings: [{ policy_id: "legacy-policy", policy_version: "1" }] })]);
    expect(policy).toMatchObject({ policyId: "legacy-policy", name: "legacy-policy", versions: [{ version: "1", contentDigest: null, definition: { id: "legacy-policy", version: "1", rules: [] } }] });
  });
});
