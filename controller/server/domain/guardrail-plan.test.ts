import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { buildGuardrailPlan } from "./guardrail-plan.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";

describe("Controller Guardrail plan", () => {
  it("turns product Policy bindings into an immutable evaluator contract graph", () => {
    const plan = buildGuardrailPlan({
      guardrailId: "guardrail-1",
      guardrailVersion: 3,
      draft: {
        purposeDetails: { audience: "", tasks: "", protect: "", outOfScope: "" },
        allowedTopics: [],
        restrictedTopics: [],
        policyBindings: [
          nativeBinding("builtin-secrets"),
          nativeBinding("builtin-pii"),
          nativeBinding("builtin-prompt-injection"),
        ],
        safetyLevel: "strict",
        outputDelivery: "full_buffered",
      },
    });

    expect(plan).toMatchObject({
      guardrail_id: "guardrail-1",
      guardrail_version: 3,
      compiler_version: "tasklattice-controller-plan-v3",
      safety_level: "strict",
    });
    expect(plan.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "secrets", contract_ref: "tali.guard.secrets.exact.v1", on_unsafe: "reject", trigger: { type: "always" } }),
      expect.objectContaining({ capability: "pii", contract_ref: "tali.guard.pii.exact.v1", trigger: { type: "always" } }),
      expect.objectContaining({ capability: "pii", contract_ref: "tali.guard.pii.semantic.v1", trigger: { type: "on_result", step_ref: "pii:exact", verdicts: ["safe", "uncertain"] } }),
      expect.objectContaining({ capability: "prompt_injection", contract_ref: "tali.guard.prompt-injection.v1", on_unsafe: "reject" }),
    ]));
    expect(plan.modules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "data_protection:input", failure_mode: "fail_closed", timeout_ms: 30_000 }),
      expect.objectContaining({ id: "interaction_safety:input", failure_mode: "fail_closed" }),
    ]));

    const balanced = buildGuardrailPlan({
      guardrailId: "guardrail-balanced",
      guardrailVersion: 1,
      draft: {
        allowedTopics: [], restrictedTopics: [],
        policyBindings: [nativeBinding("builtin-pii")],
        safetyLevel: "balanced", outputDelivery: "full_buffered",
      },
    });
    expect(balanced.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        contract_ref: "tali.guard.pii.semantic.v1",
        trigger: { type: "on_result", step_ref: "pii:exact", verdicts: ["uncertain"] },
      }),
    ]));
  });

  it("preserves the exact catalog version, enabled Rules, parameters, and action overrides", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const plan = buildGuardrailPlan({
      guardrailId: "guardrail-rich",
      guardrailVersion: 4,
      purpose: "Protect internal support traffic.",
      policies,
      draft: {
        purposeDetails: { audience: "Support agents", tasks: "Handle account support", protect: "Credentials", outOfScope: "Credential sharing" },
        allowedTopics: ["customer support"],
        restrictedTopics: ["credential sharing"],
        safetyLevel: "strict",
        outputDelivery: "full_buffered",
        policyBindings: [{
          policyId: "keyword-blocking",
          policyVersion: "1.95.0",
          action: "reject",
          parameterValues: { blocked_words: "internal-only" },
          enabledRuleIds: ["keyword/blocked-words"],
          ruleActions: { "keyword/blocked-words": "redact" },
          enabledRails: ["input"],
          reasoningPolicy: null,
        }],
      },
    });

    expect(plan.policy_bindings).toEqual([expect.objectContaining({
      policy_id: "keyword-blocking",
      policy_version: "1.95.0",
      action: "reject",
      parameter_values: [["blocked_words", "internal-only"]],
      enabled_rule_ids: ["keyword/blocked-words"],
      rule_actions: [["keyword/blocked-words", "redact"]],
      enabled_rails: ["input"],
    })]);
    expect(plan.steps).toEqual([expect.objectContaining({
      capability: "builtin_content_filter",
      contract_ref: "tali.guard.content-filter.rules.v1",
      phases: ["input"],
      on_unsafe: "reject",
      parameters: expect.arrayContaining([
        ["policy_versions_json", JSON.stringify({ "keyword-blocking": "1.95.0" })],
        ["enabled_rules_json", JSON.stringify({ "keyword-blocking": ["keyword/blocked-words"] })],
        ["rule_actions_json", JSON.stringify({ "keyword-blocking": { "keyword/blocked-words": "redact" } })],
      ]),
    })]);
    expect(plan.steps).toEqual(expect.arrayContaining([expect.objectContaining({
      capability: "builtin_content_filter",
      parameters: expect.arrayContaining([["custom_rules_json", "[]"]]),
    })]));
  });

  it("rejects a stale catalog version before it can reach Runner", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    expect(() => buildGuardrailPlan({
      guardrailId: "guardrail-stale",
      guardrailVersion: 1,
      policies,
      draft: {
        purposeDetails: { audience: "", tasks: "", protect: "", outOfScope: "" },
        allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered",
        policyBindings: [{
          policyId: "keyword-blocking", policyVersion: "0.0.1", action: null,
          parameterValues: { blocked_words: "blocked" }, enabledRuleIds: ["keyword/blocked-words"],
          ruleActions: {}, enabledRails: ["input"], reasoningPolicy: null,
        }],
      },
    })).toThrow(/version/i);
  });

  it("passes structured purpose fields and custom content rules into the immutable Runner contract", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const plan = buildGuardrailPlan({
      guardrailId: "guardrail-demo",
      guardrailVersion: 2,
      purpose: "Support account-service operations while masking nicknames and blocking disallowed slang.",
      policies,
      draft: {
        purposeDetails: {
          audience: "Support agents",
          tasks: "Summarize requests and prepare safe replies",
          protect: "Customer identifiers and internal handling instructions",
          outOfScope: "Disallowed slang and abusive nickname handling beyond masking",
        },
        allowedTopics: ["account support"],
        restrictedTopics: ["abusive slang instructions"],
        safetyLevel: "balanced",
        outputDelivery: "window_buffered",
        customContentRules: [
          { id: "mask-mama", phases: ["input"], detector: "keyword", keywords: ["mama"], action: "redact", replacement: "niulai" },
          { id: "block-xiao-sheng-zi", phases: ["input"], detector: "keyword", keywords: ["xiao sheng zi"], action: "reject" },
        ],
        policyBindings: [{
          policyId: "keyword-blocking",
          policyVersion: "1.95.0",
          action: "reject",
          parameterValues: { blocked_words: "placeholder" },
          enabledRuleIds: ["keyword/blocked-words"],
          ruleActions: {},
          enabledRails: ["input"],
          reasoningPolicy: null,
        }],
      },
    });

    expect(plan.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capability: "builtin_content_filter",
        parameters: expect.arrayContaining([
          ["custom_rules_json", JSON.stringify([
            { id: "mask-mama", phases: ["input"], detector: "keyword", keywords: ["mama"], action: "redact", replacement: "niulai" },
            { id: "block-xiao-sheng-zi", phases: ["input"], detector: "keyword", keywords: ["xiao sheng zi"], action: "reject" },
          ])],
        ]),
      }),
    ]));
  });
  it.each(["interruptible", "window_buffered", "full_buffered"] as const)(
    "preserves the %s output-delivery flag in the immutable Plan",
    (outputDelivery) => {
      const plan = buildGuardrailPlan({
        guardrailId: `guardrail-${outputDelivery}`,
        guardrailVersion: 1,
        draft: {
          allowedTopics: [],
          restrictedTopics: [],
          policyBindings: [nativeBinding("builtin-secrets")],
          safetyLevel: "balanced",
          outputDelivery,
        },
      });

      expect(plan.output_delivery).toBe(outputDelivery);
    },
  );

  it("preserves selected Rails and per-binding enforcement flags", () => {
    const plan = buildGuardrailPlan({
      guardrailId: "guardrail-rail-flags",
      guardrailVersion: 2,
      draft: {
        allowedTopics: [],
        restrictedTopics: [],
        safetyLevel: "balanced",
        outputDelivery: "full_buffered",
        policyBindings: [{
          ...nativeBinding("builtin-secrets"),
          action: "redact",
          enabledRails: ["output"],
        }],
      },
    });

    expect(plan.steps).toEqual([
      expect.objectContaining({ phases: ["output"], on_unsafe: "redact" }),
    ]);
    expect(plan.modules).toEqual([
      expect.objectContaining({ id: "data_protection:output", phase: "output" }),
    ]);
    expect(plan.policy_bindings).toEqual([
      expect.objectContaining({ action: "redact", enabled_rails: ["output"] }),
    ]);
  });
});

function nativeBinding(policyId: string) {
  return {
    policyId,
    policyVersion: "1.0.0",
    action: null,
    parameterValues: {},
    enabledRuleIds: [policyId],
    ruleActions: {},
    enabledRails: [],
    reasoningPolicy: null,
  };
}
