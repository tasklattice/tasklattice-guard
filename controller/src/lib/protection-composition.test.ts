import { describe, expect, it } from "vitest";
import { completeResponsePolicies, mergeDirectoryBindings, mergePresetBindings, policyDirectory } from "./protection-composition";
import type { GuardrailPolicyBinding, Policy } from "./api-types";

const binding = (id: string): GuardrailPolicyBinding => ({
  policy_id: id, policy_version: "2", action: null, enabled_rule_ids: ["rule"],
  rule_actions: {}, parameter_values: {}, reasoning_policy: null, enabled_rails: ["input", "output"],
});

describe("business protection composition", () => {
  it("edits a directory without regrouping other Policies or overriding order", () => {
    const first = binding("privacy-a");
    const middle = binding("attacks");
    const last = binding("privacy-b");
    const edited = { ...last, rule_actions: { rule: "block" as const } };
    const current = [first, middle, last];
    expect(mergeDirectoryBindings(current, new Set([first.policy_id, last.policy_id, "privacy-new"]), [edited, binding("privacy-new")]))
      .toEqual([middle, edited, binding("privacy-new")]);
    expect(current).toEqual([first, middle, last]);
  });

  it("does not accept out-of-directory changes", () => {
    const current = [binding("a"), binding("b")];
    expect(mergeDirectoryBindings(current, new Set(["a"]), [binding("a"), { ...binding("b"), action: "block" }, binding("c")])).toEqual(current);
  });

  it("applies presets idempotently, preserves overrides, and does not share mutable state", () => {
    const customized = { ...binding("baseline"), action: "allow" as const, rule_order: ["rule"], enabled_rails: ["input"] as ["input"] };
    const preset = [binding("baseline"), binding("banking"), binding("banking")];
    const merged = mergePresetBindings([customized], preset);
    expect(merged).toEqual([customized, binding("banking")]);
    expect(mergePresetBindings(merged, preset)).toEqual(merged);
    merged[1]!.parameter_values.bank = "Example";
    expect(preset[1]!.parameter_values).toEqual({});
  });

  it("derives full-response delivery from selected Output checks, not a two-ID allowlist", () => {
    const policy = { id: "local-passports", version: "2", name: "Passports", protection: { outputStreaming: "complete_response" } } as Policy;
    const classifier = { id: "builtin-content-safety", version: "2", name: "Content safety", protection: { outputStreaming: "incremental_check" } } as Policy;
    expect(completeResponsePolicies([binding(policy.id)], [policy])).toEqual(["Passports"]);
    expect(completeResponsePolicies([{ ...binding(policy.id), enabled_rails: ["input"] }], [policy])).toEqual([]);
    expect(completeResponsePolicies([binding(classifier.id)], [classifier])).toEqual([]);
    expect(completeResponsePolicies([{ ...binding(classifier.id), action: "transform" }], [classifier])).toEqual(["Content safety"]);
    expect(completeResponsePolicies([binding("unknown")], [])).toEqual(["unknown"]);
  });

  it("keeps unclassified custom Policies visible for manual selection", () => {
    expect(policyDirectory({ id: "custom" } as Policy)).toBe("business_rules");
  });

  it("classifies a released definition by its declared protection tag", () => {
    const released = { id: "network", tags: [{ id: "protection:privacy", namespace: "protection", value: "privacy", label: "", source: "declared" }] } as unknown as Policy;
    expect(policyDirectory(released)).toBe("privacy");
    expect(policyDirectory({ ...released, tags: [{ ...released.tags[0]!, value: "unknown" }] })).toBe("business_rules");
  });
});
