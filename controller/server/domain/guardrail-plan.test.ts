import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { buildGuardrailPlan } from "./guardrail-plan.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { programmablePolicyDraftSchema, type ProgrammablePolicySnapshot } from "../policy-studio/model.js";
import { defaultGuardrailDraft } from "./defaults.js";

describe("Controller Guardrail plan", () => {
  it("runs Guardrail-local custom rules once per phase after the last local Policy", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const draft = {
      purposeDetails: { audience: "", tasks: "", protect: "", outOfScope: "" },
      allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced" as const, outputDelivery: "full_buffered" as const,
      customContentRules: [{ id: "mask", phases: ["input", "output"] as Array<"input" | "output">, detector: "keyword" as const, keywords: ["private"], action: "redact" as const, replacement: "public" }],
      policyBindings: ["keyword-blocking", "pattern-matching"].map((id, index) => {
        const policy = policies.find((item) => item.id === id)!;
        return {
          ...nativeBinding(id), policyVersion: policy.version,
          parameterValues: id === "keyword-blocking" ? { blocked_words: "blocked" } : {},
          enabledRuleIds: policy.rules.map((rule) => rule.id),
          enabledRails: index === 0 ? ["input", "output"] as Array<"input" | "output"> : ["input"] as Array<"input">,
        };
      }),
    };
    const compiledRules = () => {
      const plan = buildGuardrailPlan({ guardrailId: "custom-order", guardrailVersion: 1, draft, policies });
      return (plan.steps as Array<{ parameters: Array<[string, string]> }>).map((step) => JSON.parse(Object.fromEntries(step.parameters).custom_rules_json!));
    };
    expect(compiledRules()).toEqual([
      [{ ...draft.customContentRules[0], phases: ["output"] }],
      [{ ...draft.customContentRules[0], phases: ["input"] }],
    ]);
    draft.policyBindings.reverse();
    expect(compiledRules()).toEqual([[], draft.customContentRules]);
  });

  it("preserves independent Policy and Rule ordering in the executable and immutable contracts", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const draft = defaultGuardrailDraft(policies);
    const template = structuredClone(policies);
    const binding = draft.policyBindings.find((item) => item.policyId === "pattern-matching")!;
    const build = () => buildGuardrailPlan({ guardrailId: "ordered", guardrailVersion: 1, draft, policies });
    binding.ruleOrder = ["pattern/email", "pattern/us_phone"];
    const first = build();
    binding.ruleOrder.reverse();
    const second = build();
    expect(second).not.toEqual(first);
    const steps = second.steps as Array<{ parameters: Array<[string, string]> }>;
    const last = Object.fromEntries(steps.at(-1)!.parameters);
    expect(JSON.parse(last.rule_order_json!)).toEqual({ "pattern-matching": ["pattern/us_phone", "pattern/email"] });
    expect((second.policy_bindings as Array<{ rule_order?: string[] }>).at(-1)?.rule_order).toEqual(binding.ruleOrder);
    draft.policyBindings.reverse();
    expect((build().policy_bindings as Array<{ policy_id: string }>)[0]!.policy_id).toBe("pattern-matching");
    expect(policies).toEqual(template);
    binding.ruleOrder = ["pattern/email", "pattern/email"];
    expect(build).toThrow(/duplicate Rules/);
    binding.ruleOrder = ["missing"];
    expect(build).toThrow(/unknown ordered Rules/);
  });
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
      compiler_version: "tasklattice-controller-plan-v5-rule-order",
      safety_level: "strict",
    });
    expect(plan.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "secrets", contract_ref: "tali.guard.secrets.exact.v1", on_unsafe: "reject", trigger: { type: "always" } }),
      expect.objectContaining({ capability: "pii", contract_ref: "tali.guard.pii.exact.v1", trigger: { type: "always" } }),
      expect.objectContaining({ capability: "pii", contract_ref: "tali.guard.pii.semantic.v1", trigger: { type: "on_result", step_ref: "pii:builtin-pii:exact", verdicts: ["safe", "uncertain"] } }),
      expect.objectContaining({ capability: "prompt_injection", contract_ref: "tali.guard.prompt-injection.v1", on_unsafe: "reject" }),
    ]));
    expect(plan.modules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "data_protection:builtin-pii:input", failure_mode: "fail_closed", timeout_ms: 30_000 }),
      expect.objectContaining({ id: "interaction_safety:builtin-prompt-injection:input", failure_mode: "fail_closed" }),
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
        trigger: { type: "on_result", step_ref: "pii:builtin-pii:exact", verdicts: ["uncertain"] },
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
      expect.objectContaining({ id: "data_protection:builtin-secrets:output", phase: "output" }),
    ]);
    expect(plan.policy_bindings).toEqual([
      expect.objectContaining({ action: "redact", enabled_rails: ["output"] }),
    ]);
  });

  it("preserves interleaved Policy order and resolves Rule > Policy > template actions", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const pattern = policies.find((item) => item.id === "pattern-matching")!;
    const keyword = policies.find((item) => item.id === "keyword-blocking")!;
    const makeBinding = (policy: typeof pattern) => ({
      ...nativeBinding(policy.id), policyVersion: policy.version,
      enabledRuleIds: policy.rules.map((item) => item.id), enabledRails: [...policy.rails],
    });
    const draft = {
      allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced" as const, outputDelivery: "full_buffered" as const,
      policyBindings: [
        { ...makeBinding(pattern), action: "reject" as const, ruleActions: { "pattern/email": "redact" as const } },
        nativeBinding("builtin-secrets"),
        { ...makeBinding(keyword), parameterValues: { blocked_words: "private" }, enabledRails: ["output" as const] },
      ],
    };
    const plan = buildGuardrailPlan({ guardrailId: "ordered", guardrailVersion: 1, draft, policies: [...policies, {
      ...keyword, id: "builtin-secrets", version: "1.0.0", parameters: [], rules: [{ ...keyword.rules[0]!, id: "builtin-secrets" }],
    }] });
    const steps = plan.steps as Array<{ parameters: Array<[string, string]>; phases: string[] }>;
    expect(steps.map((item) => Object.fromEntries(item.parameters).policy_id)).toEqual([
      "pattern-matching", "builtin-secrets", "keyword-blocking",
    ]);
    const actions = JSON.parse(Object.fromEntries(steps[0]!.parameters).rule_actions_json!)[pattern.id];
    expect(actions["pattern/email"]).toBe("redact");
    expect(actions["pattern/passport_us"]).toBe("reject");
    expect(steps[2]!.phases).toEqual(["output"]);
    const modules = plan.modules as Array<{ id: string; phase: string; depends_on: string[]; input_view: string }>;
    for (const phase of ["input", "output"]) {
      const ordered = modules.filter((item) => item.phase === phase);
      ordered.forEach((item, index) => {
        expect(item.input_view).toBe("previous_output");
        expect(item.depends_on).toEqual(index ? [ordered[index - 1]!.id] : []);
      });
    }
    expect(pattern.rules.find((item) => item.id === "pattern/passport_us")?.effect).toBe("redact");
    expect(draft.policyBindings[0]!.ruleActions).toEqual({ "pattern/email": "redact" });
  });

  it("honors native Policy Rule overrides independently for input and output", () => {
    const snapshot: ProgrammablePolicySnapshot = {
      ...programmablePolicyDraftSchema.parse({
        sources: [{ path: "main.co", content: "flow check_input $text\n  pass\nflow check_output $text\n  pass" }],
        rail_bindings: [
          { rail_type: "input", flow_name: "check_input", execution_mode: "detect", on_unsafe: "reject" },
          { rail_type: "output", flow_name: "check_output", execution_mode: "detect", on_unsafe: "reject" },
        ],
        execution_contract: [["native_risk", "content_safety"]],
      }),
      policy_id: "safety", version: "1", name: "Safety", description: "", source: "built_in", owner: "system",
      checksum: "test", published_at: "2026-09-02",
    };
    const binding = {
      ...nativeBinding("safety"), policyVersion: "1", action: "pass" as const,
      enabledRuleIds: ["flow/input/check_input", "flow/output/check_output"],
      enabledRails: ["input" as const, "output" as const],
      ruleActions: { "flow/output/check_output": "redact" as const },
    };
    const build = () => buildGuardrailPlan({
      guardrailId: "native", guardrailVersion: 1, programmablePolicies: [snapshot],
      draft: { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered", policyBindings: [binding] },
    });
    expect(build().steps).toEqual([
      expect.objectContaining({ phases: ["input"], on_unsafe: "pass" }),
      expect.objectContaining({ phases: ["output"], on_unsafe: "redact" }),
    ]);
    binding.enabledRuleIds = ["flow/output/check_output"];
    expect(build().steps).toEqual([expect.objectContaining({ phases: ["output"], on_unsafe: "redact" })]);
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
