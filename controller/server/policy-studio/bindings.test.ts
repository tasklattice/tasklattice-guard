import { describe, expect, it } from "vitest";
import { DeclarativeCompiler } from "./declarative.js";

const compiler = new DeclarativeCompiler("../runner/toolkit/policy_library/assets");

describe("Policy Rule bindings", () => {
  it("compiles one Rule resource into distinct binding identities and variants", () => {
    const template = compiler.shipped("content-filters")!;
    const definition = structuredClone(template);
    definition.metadata.id = "binding-test";
    definition.parameters = [];
    definition.tests = [];
    definition.bindings = [
      { binding_id: "denylist", rule_id: "keyword/blocked-words", order: 0, action: "block",
        parameters: { keywords: [["DENY", "high"]] } },
      { binding_id: "allowlist", rule_id: "keyword/blocked-words", variant_id: "allow", order: 1, action: "block",
        parameters: { keywords: [["ALLOW", "medium"]] } },
    ];
    definition.rules = [{ ...template.rules.find(rule => rule.id === "keyword/blocked-words")!, variants: [{ variant_id: "allow", replacement: "[ALLOW_REDACTED]", description: "" }] }];
    const compiled = compiler.compile(definition);
    expect(compiled.rules.map(rule => [rule.binding_id, rule.rule_id, rule.variant_id, rule.redaction, rule.keywords])).toEqual([
      ["binding-test/denylist", "keyword/blocked-words", null, "[KEYWORD_REDACTED]", [["DENY", "high"]]],
      ["binding-test/allowlist", "keyword/blocked-words", "allow", "[ALLOW_REDACTED]", [["ALLOW", "medium"]]],
    ]);
  });
});
