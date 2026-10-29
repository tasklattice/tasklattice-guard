import { expect, it } from "vitest";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { DeclarativeCompiler } from "../policy-studio/declarative.js";
import { buildGuardrailPlan } from "./guardrail-plan.js";
import { publishedProtectionCoverage } from "./protection-readiness.js";
import { assignmentInputSchema, assignmentTargetAcceptsModel, emptyModelAssignments } from "../model-config/domain.js";

const directory = "../runner/toolkit/policy_library/assets";
const compiler = new DeclarativeCompiler(directory);
const policies = PolicyCatalog.load(directory).list().map(p => compiler.catalogView(p));

function plan(id = "builtin-content-safety", value = "true", rails: Array<"input" | "output"> = ["input"], version?: string) {
  const policy = policies.find(p => p.id === id)!;
  const rules = id === "builtin-topic-safety" ? ["topic/denylist"] : policy.rules.map(r => r.id);
  return buildGuardrailPlan({ guardrailId: "review", guardrailVersion: "1", policies,
    draft: { safetyLevel: "balanced", outputDelivery: "full_buffered", allowedTopics: [], restrictedTopics: [], policyBindings: [{
      policyId: id, policyVersion: version ?? policy.version, action: null, enabledRails: rails, enabledRuleIds: rules,
      ruleOrder: rules, ruleActions: {}, reasoningPolicy: null,
      parameterValues: { review_unknown: value, on_unknown: "allow", topic_mode: "permissive", denied_topics: "Fraud" },
    }] } });
}

it.each(["builtin-content-safety", "builtin-jailbreak", "builtin-jailbreak-strict", "builtin-topic-safety"])("pins %s review opt-in and its input dependency", id => {
  const compiled = plan(id);
  expect(compiled.steps.every(s => Object.fromEntries(s.parameters).review_unknown === "true")).toBe(true);
  expect(publishedProtectionCoverage(compiled)!.requiredModelBindings).toContain("classifier_review.input");
  expect(publishedProtectionCoverage(plan(id,"false"))!.requiredModelBindings).not.toContain("classifier_review.input");
  expect(() => plan(id,"ignore")).toThrow("review_unknown must be true or false");
});

it.each([["builtin-content-safety","1.1.0"],["builtin-jailbreak","1.1.0"],["builtin-jailbreak-strict","1.0.0"],["builtin-topic-safety","2.1.0"]])("does not enable review on frozen %s %s",(id,version) => {
  const compiled=plan(id,"true",["input"],version);
  expect(compiled.steps.length).toBeGreaterThan(0);
  expect(compiled.steps.every(s => Object.fromEntries(s.parameters).review_unknown === undefined)).toBe(true);
  expect(publishedProtectionCoverage(compiled)!.requiredModelBindings).not.toContain("classifier_review.input");
});

it("keeps output protection and never borrows an output model binding for review",() => {
  expect(publishedProtectionCoverage(plan("builtin-content-safety","true",["output"]))!.requiredModelBindings).toEqual(["content_safety.output"]);
  expect(publishedProtectionCoverage(plan("builtin-content-safety","true",["input","output"]))!.requiredModelBindings).toEqual([
    "content_safety.input","classifier_review.input","content_safety.output",
  ]);
  expect(assignmentTargetAcceptsModel("classifier_review.input","tali.classifier-review.v1","custom-openai-compatible")).toBe(true);
  expect(assignmentTargetAcceptsModel("classifier_review.input","tali.nemotron-safety-guard-v3.v1","custom-openai-compatible")).toBe(false);
  expect(assignmentTargetAcceptsModel("content_safety.output","tali.classifier-review.v1","custom-openai-compatible")).toBe(false);
  expect(assignmentTargetAcceptsModel("control_plane","tali.classifier-review.v1","custom-openai-compatible")).toBe(false);
});

it("accepts old assignment payloads without silently changing existing assignments",() => {
  const assignments=emptyModelAssignments();
  const legacy=structuredClone(assignments);delete (legacy.bindings as Record<string,unknown>)["classifier_review.input"];
  expect(assignmentInputSchema.parse(legacy)).toEqual(assignments);
});
