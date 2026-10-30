// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { emptyPolicyDefinition, definitionIssues, policyDefinitionSchema } from "../../shared/policy-definition.js";
import { DeclarativeCompiler } from "../policy-studio/declarative.js";
import { buildGuardrailPlan, normalizeGuardrailDraft } from "../domain/guardrail-plan.js";
import { frozenBuiltInDefinition, derivesFromCatalogNode, builtInPolicyView, policyNodeDigest } from "../domain/policy-node.js";
import type { ValidationCaseResult } from "../domain/models.js";
import { assertPolicyTest } from "./policy-resources.js";
import { publicPolicy } from "../policy-catalog/public-policy.js";
import { definitionTestCases } from "../policy-studio/definition-tests.js";
import { generatedTestCases } from "../domain/validation.js";
import { PolicyCatalog, type PolicyDto } from "../policy-catalog/catalog.js";

const directory = resolve("../runner/toolkit/policy_library/assets");
const compiler = new DeclarativeCompiler(directory);
export function fixture() {
  const definition = emptyPolicyDefinition(); definition.metadata.id = "independent-policy"; definition.metadata.name = "Independent Policy"; definition.metadata.version = "1";
  definition.rules = ["first", "second"].map(id => ({ id, name: id, description: "", stages: ["input"], detector: { ref: "text/keyword", version: "1.0.0", parameters: { detector_options: { terms: [id] } } }, on_match: { action: "block" }, risk_level: "medium", metadata: { taxonomy_ids: ["TALI-BUSINESS-POLICY"] } }));
  definition.tests = definition.rules.map(rule => ({ id: `test-${rule.id}`, name: rule.name, description: "", phase: "input", content: rule.id, expected_decision: "block", covered_rule_ids: [rule.id], kind: "rule_acceptance", scope: "rule", required: true, group: "Tests", parameter_names: [] }));
  return definition;
}
function planFor(definition = fixture(), selected?: string[]) {
  const policy = compiler.compile(definition);
  return buildGuardrailPlan({ guardrailId: "test", guardrailVersion: "20261012-010000.001Z", policies: [policy], draft: normalizeGuardrailDraft({ policyBindings: [{ policyId: policy.id, policyVersion: policy.version, enabledRuleIds: selected ?? policy.rules.map(r => r.id), enabledRails: policy.rails, parameterValues: {} }] }) });
}
describe("portable Policy authoring", () => {
  it("restores protection metadata for imported frozen catalog versions without changing their identity", () => {
    const current = PolicyCatalog.load(directory).get("local-network-addresses")!;
    const node = frozenBuiltInDefinition({ ...current, version: "0.9.0" });
    const imported = { ...builtInPolicyView(node), origin: "imported", source_id: "another-installation" } as unknown as PolicyDto;
    const view = compiler.catalogView({ ...current, published_versions: [imported] });
    const historical = view.published_versions![0]!;
    expect(historical.protection).toEqual(current.protection);
    expect(historical).toMatchObject({ version: "0.9.0", origin: "imported", source_id: "another-installation" });
    expect(policyNodeDigest(frozenBuiltInDefinition(historical))).toBe(policyNodeDigest(node));
  });
  it("removes origin from public current and historical views without stripping provenance tags", () => {
    const policy = compiler.compile(fixture());
    const view = publicPolicy({ ...policy, published_versions: [policy] });
    expect(view).not.toHaveProperty("source"); expect(view.published_versions[0]).not.toHaveProperty("source");
    expect(view.tags[0]?.source).toBe("declared");
  });
  it("loads all existing definitions without source or runtime identity in the DSL", () => {
    const assets = JSON.parse(readFileSync(resolve(directory, "policy-definitions.generated.json"), "utf8"));
    expect(Object.keys(assets)).toHaveLength(27);
    for (const value of Object.values(assets)) {
      const definition = policyDefinitionSchema.parse(value);
      expect(definition.metadata).not.toHaveProperty("source");
      expect(compiler.compile(definition).rules).toHaveLength(definition.rules.length);
    }
  });
  it("requires stage-specific acceptance coverage and exact transform output", () => {
    const definition = fixture(); expect(definitionIssues(definition)).toEqual([]);
    definition.rules[0]!.stages.push("output");
    expect(definitionIssues(definition).join()).toContain("required output");
    definition.tests[0]!.expected_decision = "transform";
    expect(definitionIssues(definition).join()).toContain("complete replacement output");
    definition.tests[1]!.scope = "policy";
    expect(definitionIssues(definition).join()).toContain("second");
  });
  it("compiles any Policy ID to ordered independent Rule checks and preserves full export identity", () => {
    const definition = fixture(); definition.metadata.id = "builtin-secrets";
    const plan = planFor(definition);
    const steps = plan.steps as Array<{ capability: string; parameters: Array<[string, string]> }>;
    expect(steps).toHaveLength(2); expect(steps.every(s => s.capability === "builtin_content_filter")).toBe(true);
    expect(JSON.parse(Object.fromEntries(steps[0]!.parameters).enabled_rules_json!)).toEqual({ "builtin-secrets": ["first"] });
    expect(JSON.parse(Object.fromEntries(steps[1]!.parameters).enabled_rules_json!)).toEqual({ "builtin-secrets": ["second"] });
    const node = frozenBuiltInDefinition(compiler.compile(definition));
    expect(node).not.toHaveProperty("source");
    const frozen = JSON.parse(Object.fromEntries(steps[0]!.parameters).policy_definitions_json!)[definition.metadata.id];
    expect(derivesFromCatalogNode(node, frozen)).toBe(true);
    expect(builtInPolicyView(node).definition).toEqual(definition);
    expect(compiler.fromSnapshot(node)).toEqual(definition);
    expect(policyNodeDigest(node)).toEqual(policyNodeDigest(frozen));
  });
  it("isolates a target Rule even when a previous Rule would block the same text", () => {
    const plan = planFor(fixture(), ["second"]);
    expect(plan.steps).toHaveLength(1);
    expect(JSON.stringify(plan.steps)).toContain('second:rules');
    expect(JSON.stringify(plan.modules)).not.toContain('first:input');
  });
  it("allows a maintained platform Policy to replace its previous detector contract", () => {
    const definition = fixture(); definition.metadata.id = "configured-phrase-filter";
    expect(planFor(definition).steps).toHaveLength(2);
  });
  it("selects model contracts by detector profile for arbitrary Policy and Rule IDs", () => {
    const definition = fixture(); definition.rules[0]!.detector = { ref: "model/classifier", version: "1.0.0", parameters: { profile: "safety-classification" } };
    const steps = planFor(definition).steps as Array<{ contract_ref: string; parameters: Array<[string, string]> }>;
    expect(steps).toHaveLength(2);
    // Local blocking checks run before model calls, retaining each Rule's contract.
    expect(steps.map(step => step.contract_ref)).toEqual([
      "tali.guard.content-filter.rules.v1", "tali.guard.content-safety.v1",
    ]);
    expect(JSON.parse(Object.fromEntries(steps[0]!.parameters).enabled_rules_json!)).toEqual({ "independent-policy": ["second"] });
    expect(Object.fromEntries(steps[1]!.parameters)).toMatchObject({ policy_id: "independent-policy", rule_id: "first", declarative_rule: "true" });
  });
  it("preserves Topic Rule configuration when a shipped definition is renamed and exported", () => {
    const definition = compiler.shipped("builtin-topic-safety")!;
    definition.metadata.id = "our-topic-policy";
    definition.parameters.find(p => p.name === "denied_topics")!.default = "gambling";
    definition.parameters.find(p => p.name === "allowed_topics")!.default = "banking";
    definition.parameters.find(p => p.name === "topic_mode")!.default = "strict";
    const steps = planFor(definition).steps as Array<{ parameters: Array<[string, string]> }>;
    expect(Object.fromEntries(steps[0]!.parameters)).toMatchObject({ policy_id: "our-topic-policy", topic_mode: "permissive", restricted_topics: "gambling", allowed_topics: "" });
    expect(Object.fromEntries(steps[1]!.parameters)).toMatchObject({ policy_id: "our-topic-policy", topic_mode: "strict", allowed_topics: "banking", restricted_topics: "" });
  });
  it("expands parameterized phrase tests from the Rule contract without relying on a Policy ID", () => {
    const definition = compiler.shipped("configured-phrase-filter")!;
    definition.metadata.id = "our-phrase-policy";
    const values = { phrase_entries: JSON.stringify([{ id: "hidden", phrase: "PRIVATE", action: "transform", replacement: "[hidden]" }]) };
    const cases = definitionTestCases(definition, values);
    expect(cases).toHaveLength(2);
    expect(cases[0]).toMatchObject({ content: "PRIVATE", expected_decision: "transform", expected_text: "[hidden]", covered_rule_ids: ["configured/phrases/hidden"] });
    const policy = compiler.compile(definition);
    const inherited = generatedTestCases("g", normalizeGuardrailDraft({ policyBindings: [{ policyId: policy.id, policyVersion: policy.version, enabledRuleIds: ["configured/phrases"], parameterValues: values }] }), [policy]);
    expect(inherited).toHaveLength(2); expect(inherited[0]).toMatchObject({ content: "PRIVATE", expectedDecision: "transform", coveredRuleIds: ["configured/phrases/hidden"] });
    definition.metadata.id = "configured-phrase-filter"; definition.rules = fixture().rules; definition.tests = fixture().tests;
    const changed = compiler.compile(definition);
    expect(generatedTestCases("g", normalizeGuardrailDraft({ policyBindings: [{ policyId: changed.id, policyVersion: changed.version, enabledRuleIds: ["first", "second"] }] }), [changed])).toHaveLength(2);
  });
  it("carries each formal Rule's versioned service policy through export and compilation", () => {
    const definition = fixture();
    for (const [index, rule] of definition.rules.entries()) {
      rule.stages = ["output"];
      rule.detector = { ref: "service/formal-verification", version: "1.0.0", parameters: { policy_id: "refund-terms", policy_version: String(index + 1), confidence_threshold: 0.85 } };
    }
    const restored = compiler.fromSnapshot(frozenBuiltInDefinition(compiler.compile(definition)));
    expect(restored).toEqual(definition);
    const plan = planFor(restored);
    const snapshots = plan.reasoning_policies as Array<Record<string, unknown>>;
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({ policy_id: "refund-terms", policy_version: "1", confidence_threshold: 0.85 });
    expect(snapshots[1]).toMatchObject({ policy_id: "refund-terms", policy_version: "2" });
    expect(new Set(snapshots.map(s => s.id)).size).toBe(2);
    const steps = plan.steps as Array<{ parameters: Array<[string, string]> }>;
    expect(steps.map(s => Object.fromEntries(s.parameters).policy_snapshot_id)).toEqual(snapshots.map(s => s.id));
    expect(planFor(restored, ["second"]).reasoning_policies).toHaveLength(1);
  });
  it("rejects incomplete Grounding and formal proof acceptance context", () => {
    const definition = fixture(); definition.rules = [definition.rules[0]!]; definition.tests = [definition.tests[0]!];
    const rule = definition.rules[0]!; const test = definition.tests[0]!;
    rule.stages = ["output"]; test.phase = "output";
    rule.detector = { ref: "model/grounding", version: "1.0.0", parameters: { grounding_threshold: "" } };
    expect(definitionIssues(definition).join()).toContain("grounding_threshold");
    expect(definitionIssues(definition).join()).toContain("user query");
    expect(definitionIssues(definition).join()).toContain("grounding source");
    rule.detector.parameters = { grounding_threshold: 0.7 };
    test.context = { query: "Warranty?", grounding_sources: ["One year"], trusted_instruction: "", expected_reasoning_result: null };
    expect(definitionIssues(definition)).toEqual([]);
    rule.detector = { ref: "service/formal-verification", version: "1.0.0", parameters: {} };
    expect(definitionIssues(definition).join()).toContain("formal policy ID and version");
    expect(definitionIssues(definition).join()).toContain("expected reasoning result");
    rule.detector.parameters = { policy_id: "refund", policy_version: "1", confidence_threshold: 0.9 };
    test.context.expected_reasoning_result = "invalid";
    expect(definitionIssues(definition)).toEqual([]);
    const actual = { passed: true, actualDecision: "block", actualReasoningResult: "translation_ambiguous", findings: [], modelInvocations: 1 } as unknown as ValidationCaseResult;
    const report = assertPolicyTest({ ...test, kind: "scenario", scope: "policy" }, actual);
    expect(report.passed).toBe(false); expect(report.reason).toContain("Expected proof invalid");
    expect(report.actualReasoningResult).toBe("translation_ambiguous");
  });
  it("does not accept unknown verdicts, preemption, missing results or incorrect replacement text", () => {
    const test = fixture().tests[0]!;
    const actual = { caseId: test.id, passed: true, actualDecision: "block", sourcePolicyId: "independent-policy", findings: [{ rule_id: "first", policy_id: "independent-policy", verdict: "matched" }], matchedRuleIds: ["first"], outputContent: "" } as ValidationCaseResult;
    expect(assertPolicyTest(test, actual).passed).toBe(true);
    expect(assertPolicyTest(test, { ...actual, findings: [{ ...actual.findings[0], verdict: "unknown" }] }).passed).toBe(false);
    expect(assertPolicyTest(test, { ...actual, findings: [{ ...actual.findings[0], rule_id: "second" }] }).passed).toBe(false);
    expect(assertPolicyTest(test).passed).toBe(false);
    expect(assertPolicyTest({ ...test, expected_text: "[REDACTED]" }, actual).passed).toBe(false);
  });
});
