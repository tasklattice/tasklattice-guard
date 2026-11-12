import { expect, it } from "vitest";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { DeclarativeCompiler } from "../policy-studio/declarative.js";
import { buildGuardrailPlan } from "./guardrail-plan.js";
import { publishedProtectionCoverage } from "./protection-readiness.js";
import { assignmentTargetAcceptsModel } from "../model-config/domain.js";

const directory = "../runner/toolkit/policy_library/assets";
const compiler = new DeclarativeCompiler(directory);
const policies = PolicyCatalog.load(directory).list().map(p => compiler.catalogView(p));

function plan(id: string, rails: Array<"input" | "output"> = ["input"]) {
  const policy = policies.find(p => p.id === id)!;
  const rules = policy.rules.filter(rule => rule.detector.ref === "model/classifier").map(rule => rule.id);
  return buildGuardrailPlan({ guardrailId: "review", guardrailVersion: "1", policies,
    draft: { safetyLevel: "balanced", outputDelivery: "full_buffered", allowedTopics: [], restrictedTopics: [], policyBindings: [{
      policyId: id, policyVersion: policy.version, action: null, enabledRails: rails, enabledRuleIds: rules,
      ruleOrder: rules, ruleActions: {}, reasoningPolicy: null,
      parameterValues: { on_unknown: "allow", topic_mode: "permissive", denied_topics: "Fraud" },
    }] } });
}

it.each(["content-safety-model", "prompt-instruction-attacks", "pii-semantic", "business-topics"])("compiles %s without a required review model", id => {
  const compiled = plan(id);
  expect(compiled.steps.length).toBeGreaterThan(0);
  expect(publishedProtectionCoverage(compiled)!.requiredModelBindings).not.toContain("classifier_review.input");
});

it("keeps input and output review assignments optional for classifier Rules", () => {
  expect(publishedProtectionCoverage(plan("content-safety-model", ["output"]))!.requiredModelBindings).toEqual(["content_safety.output"]);
  expect(publishedProtectionCoverage(plan("content-safety-model", ["input", "output"]))!.requiredModelBindings).toEqual(["content_safety.input", "content_safety.output"]);
  expect(publishedProtectionCoverage(plan("pii-semantic", ["input", "output"]))!.requiredModelBindings).toEqual(["pii_semantic.input", "pii_semantic.output"]);
});

it("validates model compatibility for independent review assignments", () => {
  expect(assignmentTargetAcceptsModel("classifier_review.input","tali.classifier-review.v1","custom-openai-compatible")).toBe(true);
  expect(assignmentTargetAcceptsModel("classifier_review.output","generic-chat","deepseek")).toBe(true);
  expect(assignmentTargetAcceptsModel("classifier_review.input","generic-chat","custom-openai-compatible")).toBe(true);
  expect(assignmentTargetAcceptsModel("classifier_review.input","tali.nemotron-safety-guard-v3.v1","custom-openai-compatible")).toBe(false);
  expect(assignmentTargetAcceptsModel("content_safety.output","tali.classifier-review.v1","custom-openai-compatible")).toBe(false);
  expect(assignmentTargetAcceptsModel("control_plane","tali.classifier-review.v1","custom-openai-compatible")).toBe(false);
});
