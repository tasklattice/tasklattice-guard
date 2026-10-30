// @vitest-environment node
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { fullFeatureBaseline } from "../../shared/full-feature-baseline.js";
import { PolicyCatalog } from "./catalog.js";
import { DeclarativeCompiler } from "../policy-studio/declarative.js";
import { profileDraft, previewProtectionProfile } from "./presets.js";
import { buildGuardrailPlan, normalizeGuardrailDraft } from "../domain/guardrail-plan.js";
import { applyValidationOverrides, generatedTestCases, reconcileValidationOverrides } from "../domain/validation.js";
import { publishedProtectionCoverage } from "../domain/protection-readiness.js";
import { selectedModelDependencies } from "../../src/lib/protection-dependencies.js";
import type { GuardrailPolicyBinding, Policy } from "../../src/lib/api-types.js";
const directory = resolve("../runner/toolkit/policy_library/assets");
const compiler = new DeclarativeCompiler(directory);
const catalog = PolicyCatalog.load(directory).list().map(policy => compiler.catalogView(policy));
const fresh = () => profileDraft(fullFeatureBaseline, catalog);
const cases = (draft: ReturnType<typeof fresh>) => generatedTestCases("baseline", draft, catalog);
const reconcile = (draft: ReturnType<typeof fresh>, reference = fresh()) => {
  reconcileValidationOverrides(draft, reference, cases(reference));
  return applyValidationOverrides(cases(draft), draft);
};

it("pins the expanded benchmark-family configuration without instance resources", () => {
  const draft = fresh();
  expect(draft.profileOrigin).toEqual({ id: "full-feature-baseline", version: "1.0.0" });
  expect(normalizeGuardrailDraft(draft)).toEqual(draft);
  expect(draft.outputDelivery).toBe("full_buffered");
  expect(draft.topicControlMode).toBe("permissive");
  expect(draft.policyBindings).toHaveLength(14);
  expect(draft.policyBindings.flatMap(binding => binding.enabledRuleIds)).toHaveLength(127);
  expect(draft.policyBindings.flatMap(binding => Object.keys(binding.testCaseOverrides ?? {}))).toHaveLength(106);
  const plan = buildGuardrailPlan({ guardrailId: "baseline", guardrailVersion: "1", draft, policies: catalog });
  const steps = plan.steps as Array<{ contract_ref: string; parameters: Array<[string, string]>; phases: string[] }>;
  const jailbreak = steps.find(step => step.contract_ref === "tali.guard.jailbreak.v1")!;
  expect(jailbreak.parameters).toContainEqual(["on_unknown", "block"]);
  expect(jailbreak.phases).toEqual(["input"]);
  expect(steps.filter(step => step.contract_ref === "tali.guard.content-safety.v1").flatMap(step => step.phases)).toEqual(["input", "output"]);
  expect(() => applyValidationOverrides(cases(draft), draft)).not.toThrow();
  expect(catalog.find(policy => policy.id === "builtin-jailbreak-strict")!.protection.modelCapabilities).toEqual(["jailbreak"]);
});

it.each(fullFeatureBaseline.policies.map(policy => policy.policyId))("keeps remaining tests valid after removing %s", id => {
  const draft = fresh();
  draft.policyBindings = draft.policyBindings.filter(binding => binding.policyId !== id);
  const result = reconcile(draft);
  expect(result.some(test => test.sourcePolicyId === id)).toBe(false);
  expect(result.length).toBeGreaterThan(0);
  expect(draft.profileOrigin).toEqual(fresh().profileOrigin);
});

it("restores the five cross-policy Contact assertions and retains unrelated overlays", () => {
  const draft = fresh();
  draft.policyBindings = draft.policyBindings.filter(binding => binding.policyId !== "local-government-identifiers");
  const contact = draft.policyBindings.find(binding => binding.policyId === "local-contact-data")!;
  const dependentIds = Object.entries(contact.testCaseOverrides!).filter(([, overlay]) => overlay.expectedMatches.some(match => match.policyId === "local-government-identifiers")).map(([id]) => id);
  expect(dependentIds).toHaveLength(5);
  const result = reconcile(draft);
  expect(Object.keys(contact.testCaseOverrides!)).toHaveLength(25);
  for (const id of dependentIds) {
    const test = result.find(item => item.sourcePolicyId === contact.policyId && item.sourceCaseId === id)!;
    expect(test).toBeDefined();
    expect(test.expectationOverride).toBeUndefined();
    expect(test.expectedDecision).toBe(cases(draft).find(item => item.id === test.id)!.expectedDecision);
  }
});

it("cleans inherited overlays when any covered Rule or Rail is deselected", () => {
  for (const original of fresh().policyBindings) {
    for (const rule of original.enabledRuleIds) {
      if (original.enabledRuleIds.length === 1) continue;
      const draft = fresh();
      const binding = draft.policyBindings.find(item => item.policyId === original.policyId)!;
      binding.enabledRuleIds = binding.enabledRuleIds.filter(id => id !== rule);
      binding.ruleOrder = binding.ruleOrder!.filter(id => id !== rule);
      expect(() => reconcile(draft), `${binding.policyId}/${rule}`).not.toThrow();
    }
    for (const rail of original.enabledRails.length > 1 ? original.enabledRails : []) {
      const draft = fresh();
      draft.policyBindings.find(item => item.policyId === original.policyId)!.enabledRails = [rail];
      expect(() => reconcile(draft)).not.toThrow();
    }
  }
});

const dependencies = (draft: ReturnType<typeof fresh>) => {
  const plan = buildGuardrailPlan({ guardrailId: "baseline", guardrailVersion: "1", draft, policies: catalog });
  const bindings = draft.policyBindings.map(binding => ({ policy_id: binding.policyId, policy_version: binding.policyVersion,
    enabled_rule_ids: binding.enabledRuleIds, enabled_rails: binding.enabledRails })) as GuardrailPolicyBinding[];
  const ui = selectedModelDependencies(bindings, catalog as unknown as Policy[]);
  expect(ui.unknownPolicies).toEqual([]);
  expect(publishedProtectionCoverage(plan)?.hasUnknownDependencies).toBe(false);
  const backend = publishedProtectionCoverage(plan)!.requiredModelBindings.sort();
  expect(ui.required.map(item => item.id).sort()).toEqual(backend);
  return backend;
};

it("resolves six directional model assignments and drops only removed dependencies", () => {
  const draft = fresh();
  expect(dependencies(draft)).toEqual([
    "content_safety.input", "content_safety.output", "jailbreak.input",
    "pii_semantic.input", "pii_semantic.output", "topic_control.input",
  ]);
  draft.policyBindings.find(binding => binding.policyId === "builtin-content-safety")!.enabledRails = ["input"];
  draft.policyBindings.find(binding => binding.policyId === "builtin-pii")!.enabledRails = ["output"];
  draft.policyBindings = draft.policyBindings.filter(binding => binding.policyId !== "builtin-topic-safety");
  expect(dependencies(draft)).toEqual(["content_safety.input", "jailbreak.input", "pii_semantic.output"]);
  const reduced = reconcile(draft);
  expect(reduced.some(test => test.sourcePolicyId === "builtin-content-safety" && test.phase === "output")).toBe(false);
  expect(reduced.some(test => test.sourcePolicyId === "builtin-pii" && test.phase === "input")).toBe(false);
  expect(reduced.some(test => test.sourcePolicyId === "builtin-topic-safety")).toBe(false);
  draft.policyBindings = draft.policyBindings.filter(binding => !["builtin-content-safety", "builtin-pii", "builtin-jailbreak-strict"].includes(binding.policyId));
  expect(dependencies(draft)).toEqual([]);
  expect(() => reconcile(draft)).not.toThrow();
});

it("enables injection and memory boundaries with real source contexts and a filled denylist", () => {
  const draft = fresh();
  const tests = reconcile(draft);
  for (const id of ["local-injection-protection", "builtin-indirect-prompt-injection", "builtin-memory-poisoning", "local-data-use-boundaries"]) {
    expect(draft.policyBindings.some(binding => binding.policyId === id)).toBe(true);
    expect(tests.some(test => test.sourcePolicyId === id)).toBe(true);
  }
  for (const id of ["builtin-indirect-prompt-injection", "builtin-memory-poisoning"]) {
    const boundaries = tests.filter(test => test.sourcePolicyId === id);
    expect(boundaries.some(test => test.targetSource === "retrieved_content")).toBe(true);
    expect(boundaries.some(test => test.targetSource === "tool_output")).toBe(true);
  }
  expect(tests.some(test => test.sourcePolicyId === "builtin-content-safety" && test.phase === "output")).toBe(true);
  const topic = draft.policyBindings.find(binding => binding.policyId === "builtin-topic-safety")!;
  expect(topic.enabledRuleIds).toEqual(["topic/denylist"]);
  expect(topic.parameterValues.allowed_topics).toBe("");
  expect(topic.parameterValues.denied_topics.split("\n")).toHaveLength(6);
  expect(tests.filter(test => test.sourcePolicyId === topic.policyId)).toHaveLength(6);
  expect(tests.filter(test => test.sourcePolicyId === topic.policyId).every(test => !test.content.includes("{{"))).toBe(true);
});

it("rejects edited, unavailable and stale overrides instead of dropping assertions", () => {
  const draft = fresh();
  draft.policyBindings = draft.policyBindings.filter(binding => binding.policyId !== "local-government-identifiers");
  const contact = draft.policyBindings.find(binding => binding.policyId === "local-contact-data")!;
  Object.values(contact.testCaseOverrides!).find(item => item.expectedMatches.some(match => match.policyId === "local-government-identifiers"))!.reason = "New user expectation";
  expect(() => reconcile(draft)).toThrow(/not enabled/);
  const invalid = fresh();
  const binding = invalid.policyBindings[0]!;
  binding.testCaseOverrides = { missing: { sourcePolicyVersion: binding.policyVersion, reason: "new", expectedDecision: "block", expectedMatches: [{ policyId: binding.policyId, ruleId: binding.enabledRuleIds[0]! }] } };
  expect(() => reconcile(invalid)).toThrow(/unavailable Test Case/);
  const stale = fresh();
  Object.values(stale.policyBindings[1]!.testCaseOverrides!)[0]!.sourcePolicyVersion = "old";
  expect(() => reconcile(stale)).toThrow(/stale/);
});

it("supports subsequent deletions using the previous draft without its source Profile", () => {
  const previous = fresh();
  delete previous.profileOrigin;
  const draft = structuredClone(previous);
  draft.policyBindings = draft.policyBindings.filter(binding => binding.policyId !== "local-government-identifiers");
  expect(() => reconcile(draft, previous)).not.toThrow();
});

it("isolates unavailable Profiles and never substitutes a different pin", () => {
  const missing = catalog.filter(policy => policy.id !== "builtin-jailbreak-strict");
  expect(previewProtectionProfile(fullFeatureBaseline, missing)).toMatchObject({ policyBindings: [], availability: { available: false } });
  const newer = catalog.map(policy => policy.id === "builtin-jailbreak-strict" ? { ...policy, version: "1.0.1", published_versions: [] } : policy);
  expect(() => profileDraft(fullFeatureBaseline, newer)).toThrow(/requires version 1.0.0/);
  expect(previewProtectionProfile(fullFeatureBaseline, catalog).availability.available).toBe(true);
});
