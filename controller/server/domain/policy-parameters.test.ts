// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { emptyPolicyDefinition, definitionIssues, type PolicyDefinition } from "../../shared/policy-definition.js";
import { activePolicyParameters, policyBindingParameterIssues } from "../../shared/policy-parameters.js";
import { DeclarativeCompiler } from "../policy-studio/declarative.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { buildGuardrailPlan, normalizeGuardrailDraft } from "./guardrail-plan.js";
import { frozenBuiltInDefinition } from "./policy-node.js";

const compiler = new DeclarativeCompiler(resolve("../runner/toolkit/policy_library/assets"));
function parameter(name: string, kind = "text", required = true, fallback: string | null = null) {
  return { name, label: name, kind, required, default: fallback, description: "", placeholder: "" };
}
function topic(): PolicyDefinition {
  const definition = compiler.shipped("builtin-topic-safety")!;
  definition.metadata.id = "business-independent-topics";
  definition.parameters.find(p => p.name === "allowed_topics")!.required = true;
  definition.testing = { parameters: { allowed_topics: "Test-only business", denied_topics: "Test-only restriction" } };
  return definition;
}
function plan(definition: PolicyDefinition, values: Record<string, string>, selected = definition.rules.map(r => r.id)) {
  const policy = compiler.compile(definition);
  return buildGuardrailPlan({ guardrailId: "example", guardrailVersion: "1", policies: [policy], draft: normalizeGuardrailDraft({ policyBindings: [{ policyId: policy.id, policyVersion: policy.version, enabledRuleIds: selected, enabledRails: policy.rails, parameterValues: values }] }) });
}
function stepValues(value: ReturnType<typeof plan>) {
  return (value.steps as Array<{ parameters: Array<[string, string]> }>).map(s => Object.fromEntries(s.parameters));
}

describe("model Policy parameter instantiation", () => {
  it("keeps two Guardrails independent and excludes Policy testing values from bindings", () => {
    const definition = topic(); const original = structuredClone(definition);
    const first = plan(definition, { allowed_topics: "Order support", denied_topics: "Gambling", topic_mode: "strict" });
    const second = plan(definition, { allowed_topics: "Insurance claims", denied_topics: "Investment advice" });
    expect(stepValues(first)).toEqual(expect.arrayContaining([expect.objectContaining({ restricted_topics: "Gambling" }), expect.objectContaining({ allowed_topics: "Order support", topic_mode: "strict" })]));
    expect(stepValues(second)).toEqual(expect.arrayContaining([expect.objectContaining({ restricted_topics: "Investment advice" }), expect.objectContaining({ allowed_topics: "Insurance claims" })]));
    expect(stepValues(first).some(p => p.allowed_topics === "Insurance claims")).toBe(false);
    expect(stepValues(second).some(p => p.allowed_topics === "Test-only business")).toBe(false);
    expect(definition).toEqual(original);
    expect(() => plan(definition, {})).toThrow("Allowed topics");
    expect(compiler.fromSnapshot(frozenBuiltInDefinition(compiler.compile(definition)))).toEqual(definition);
  });
  it("uses declared defaults, accepts explicit overrides and substitutes only once", () => {
    const definition = topic(); definition.parameters.find(p => p.name === "allowed_topics")!.default = "Default support";
    expect(stepValues(plan(definition, {}))).toEqual(expect.arrayContaining([expect.objectContaining({ allowed_topics: "Default support" })]));
    expect(stepValues(plan(definition, { allowed_topics: "Explain literal {{other}} placeholders" }))).toEqual(expect.arrayContaining([expect.objectContaining({ allowed_topics: "Explain literal {{other}} placeholders" })]));
    expect(() => plan(definition, { allowed_topics: "" })).toThrow("Allowed topics");
  });
  it("requires only parameters used by enabled model Rules and Rails", () => {
    const definition = topic(); const deny = definition.rules.find(r => String(r.detector.parameters.restricted_topics).includes("denied_topics"))!;
    expect(activePolicyParameters(definition, [deny.id]).map(p => p.name)).not.toContain("allowed_topics");
    expect(() => plan(definition, { denied_topics: "Fraud" }, [deny.id])).not.toThrow();
    expect(policyBindingParameterIssues(definition, {}, [deny.id], ["output"])).toEqual([]);
    expect(() => plan(definition, { allowed_topics: "", topic_mode: "strict" })).toThrow("strict mode requires allowed topics");
    expect(() => plan(definition, { allowed_topics: "Support", topic_mode: "anything" })).toThrow("strict or permissive");
  });
  it.each(["{{missing}}", "{{invalid-name}}"])("rejects invalid reference %s before publishing", reference => {
    const definition = topic(); definition.rules[0]!.detector.parameters.restricted_topics = reference;
    expect(definitionIssues(definition).join(" ")).toMatch(/not declared|invalid parameter reference/);
    expect(() => compiler.compile(definition)).toThrow(/not declared|invalid parameter reference/);
  });
  it("rejects parameterized detector profiles and incompatible parameter types", () => {
    const definition = topic(); definition.rules[0]!.detector.parameters.profile = "{{topic_mode}}";
    expect(() => compiler.compile(definition)).toThrow("cannot reference");
    definition.rules[0]!.detector.parameters.profile = "topic-classification";
    definition.parameters.find(p => p.name === "denied_topics")!.kind = "number";
    expect(() => compiler.compile(definition)).toThrow("incompatible type");
  });
  it("resolves grounding and formal parameters into concrete versioned execution snapshots", () => {
    const definition = emptyPolicyDefinition(); definition.metadata.name = "Reusable response checks";
    definition.parameters = [parameter("score", "number", true, "0.7"), parameter("formal_id"), parameter("formal_version"), parameter("confidence", "number", true, "0.8")];
    const common = { description: "", stages: ["output"] as ["output"], on_match: { action: "block" as const }, risk_level: "medium" as const, metadata: { taxonomy_ids: ["TALI-RESPONSE-INTEGRITY"] } };
    definition.rules = [
      { ...common, id: "ground", name: "Grounding", detector: { ref: "model/grounding", version: "1.0.0", parameters: { grounding_threshold: "{{score}}", relevance_threshold: "{{score}}" } } },
      { ...common, id: "proof", name: "Formal verification", detector: { ref: "service/formal-verification", version: "1.0.0", parameters: { policy_id: "{{formal_id}}", policy_version: "{{formal_version}}", confidence_threshold: "{{confidence}}" } } },
    ];
    const compiled = plan(definition, { score: "0.9", formal_id: "warranty-terms", formal_version: "4", confidence: "0.85" });
    expect(stepValues(compiled)[0]).toMatchObject({ grounding_threshold: "0.9", relevance_threshold: "0.9" });
    expect(compiled.reasoning_policies).toEqual([expect.objectContaining({ policy_id: "warranty-terms", policy_version: "4", confidence_threshold: 0.85 })]);
    expect(stepValues(plan(definition, {}, ["ground"]))[0]).toMatchObject({ grounding_threshold: "0.7" });
    for (const score of ["NaN", "1.1", "", "-0.1"]) expect(() => plan(definition, { score }, ["ground"])).toThrow();
    expect(() => plan(definition, {}, ["proof"])).toThrow("formal_id");
    definition.rules[0]!.detector.parameters.grounding_threshold = "0.{{score}}";
    expect(() => compiler.compile(definition)).toThrow("single number parameter");
  });
});

describe("scoped classifier uncertainty handling", () => {
  it.each(["builtin-jailbreak", "builtin-content-safety", "builtin-topic-safety"])("instantiates the shipped native %s parameter in the actual execution plan", id => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const policy = policies.find(p => p.id === id)!;
    const build = (version: string, on_unknown?: string) => buildGuardrailPlan({guardrailId: "native", guardrailVersion: "1", policies,
      draft: normalizeGuardrailDraft({policyBindings: [{policyId: id, policyVersion: version,
        enabledRuleIds: policy.rules.map(r => r.id), enabledRails: ["input"],
        parameterValues: {denied_topics: "Fraud", topic_mode: "permissive", ...(on_unknown ? {on_unknown} : {})}}]})});
    expect(stepValues(build(policy.version))).toEqual(expect.arrayContaining([expect.objectContaining({on_unknown: "block"})]));
    expect(stepValues(build(policy.version, "allow")).every(p => p.on_unknown === "allow")).toBe(true);
    expect(() => build(policy.version, "ignore")).toThrow("on_unknown must be allow or block");
  });
  function classifier(id = "builtin-jailbreak") {
    const definition = compiler.shipped(id)!;
    definition.metadata.id = "explicit-classifier-enforcement";
    return definition;
  }
  it.each(["builtin-jailbreak", "builtin-content-safety", "builtin-topic-safety"])("pins %s uncertainty without changing matched actions", id => {
    const definition = classifier(id);
    const strict = plan(definition, {}), observe = plan(definition, { on_unknown: "allow" });
    expect(stepValues(strict).every(p => p.on_unknown === "block")).toBe(true);
    expect(stepValues(observe).every(p => p.on_unknown === "allow")).toBe(true);
    expect((observe.steps as Array<{on_unsafe:string}>).every(s => s.on_unsafe === "block")).toBe(true);
    expect(() => plan(definition, { on_unknown: "ignore" })).toThrow("on_unknown must be allow or block");
    expect(stepValues(plan(compiler.shipped(id)!, {})).every(p => p.on_unknown === "block")).toBe(true);
  });
  it("rejects invalid literals and unsupported detector scopes", () => {
    const definition = classifier();definition.rules[0]!.detector.parameters.on_unknown = "ignore";
    expect(() => compiler.compile(definition)).toThrow("on_unknown must be allow or block");
    const other = classifier();other.rules[0]!.detector.parameters.profile = "pii-classification";
    expect(() => compiler.compile(other)).toThrow("supported only by the jailbreak, content safety and topic classifiers");
  });
});
