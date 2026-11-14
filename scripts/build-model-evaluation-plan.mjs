// Build the offline evaluation plan from the shipped Policy catalog.
import { PolicyCatalog } from "../controller/server/policy-catalog/catalog.ts";
import { DeclarativeCompiler } from "../controller/server/policy-studio/declarative.ts";
import { buildGuardrailPlan } from "../controller/server/domain/guardrail-plan.ts";

const assets = new URL("../runner/toolkit/policy_library/assets/", import.meta.url).pathname;
const compiler = new DeclarativeCompiler(assets);
const policies = PolicyCatalog.load(assets).list().map((policy) => compiler.catalogView(policy));
const specifications = [
  ["content-safety-model", ["input", "output"], ["model/content-safety"]],
  ["prompt-instruction-attacks", ["input"], [
    "model/jailbreak", "boundary/indirect-injection", "boundary/memory-poisoning",
  ]],
  ["pii-semantic", ["input", "output"], ["model/pii"]],
  ["credentials-secrets", ["input", "output"], null],
];
const policyBindings = specifications.map(([id, enabledRails, rules]) => {
  const policy = policies.find((item) => item.id === id);
  if (!policy) throw new Error(`Missing Policy ${id}`);
  const enabledRuleIds = rules ?? policy.rules.map((rule) => rule.id);
  return {
    policyId: id, policyVersion: policy.version, action: null, enabledRails,
    enabledRuleIds, ruleOrder: enabledRuleIds, ruleActions: {}, reasoningPolicy: null, parameterValues: {},
  };
});
const plan = buildGuardrailPlan({
  guardrailId: "laya-model-evaluation", guardrailVersion: "20261114-000000.000Z", policies,
  draft: { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced",
    outputDelivery: "full_buffered", policyBindings },
});
const profileRef = "tali.laya.v1";
const layaRuntimeId = "laya-offline";
const bindings = [
  ["content_safety", "input", "tali.guard.content-safety.v1"],
  ["content_safety", "output", "tali.guard.content-safety.v1"],
  ["jailbreak", "input", "tali.guard.jailbreak.v1"],
  ["pii_semantic", "input", "tali.guard.pii.semantic.v1"],
  ["pii_semantic", "output", "tali.guard.pii.semantic.v1"],
].map(([capabilityRef, phase, contractRef]) => ({
  bindingId: `${capabilityRef}.${phase}`, capabilityRef, railType: `RAIL_TYPE_${phase.toUpperCase()}`,
  modelRef: layaRuntimeId, profileRef, contractRefs: [contractRef],
}));
console.log(JSON.stringify({
  schemaVersion: "1.0", plan, layaRuntimeId,
  modelConfiguration: {
    runtimes: [{ id: layaRuntimeId, model: "laya-english", backend: "builtin_laya", profileRef,
      timeoutSeconds: 20, maxConcurrency: 1, rateLimitAttempts: 1 }],
    bindings,
  },
}, null, 2));
