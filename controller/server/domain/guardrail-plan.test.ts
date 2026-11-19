import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { buildGuardrailPlan } from "./guardrail-plan.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { programmablePolicyDraftSchema, type ProgrammablePolicySnapshot } from "../policy-studio/model.js";
import { defaultGuardrailDraft } from "./defaults.js";
import { DeclarativeCompiler } from "../policy-studio/declarative.js";

describe("Controller Guardrail plan", () => {
  it.each([
    ["prompt-instruction-attacks", "indirect_prompt_injection", "tali.guard.indirect-prompt-injection.v1"],
    ["prompt-instruction-attacks", "memory_poisoning", "tali.guard.memory-poisoning.v1"],
  ])("keeps the boundary Action when %s is authored as a custom Policy", (id, capability, contract) => {
    const compiler = new DeclarativeCompiler(resolve("../runner/toolkit/policy_library/assets"));
    const definition = compiler.shipped(id!)!;
    definition.metadata.id = `custom-${capability}`;
    const targetRule = capability === "indirect_prompt_injection" ? "boundary/indirect-injection" : "boundary/memory-poisoning";
    definition.rules = definition.rules.filter(item => item.id === targetRule);
    definition.tests = definition.tests.filter(test => test.covered_rule_ids.every(ruleId => ruleId === targetRule));
    const policy = compiler.compile(definition);
    const rule = policy.rules[0]!;
    const binding = { ...nativeBinding(policy.id), policyVersion: policy.version,
      enabledRuleIds: [rule.id], enabledRails: ["input"], ruleActions: { [rule.id]: "allow" as const } };
    const plan = buildGuardrailPlan({ guardrailId: "custom-boundary", guardrailVersion: "20261019-010000.001Z", policies: [policy],
      draft: { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered", policyBindings: [binding] } });
    expect(plan.steps).toEqual([expect.objectContaining({ capability, contract_ref: contract, phases: ["input"], on_unsafe: "allow",
      parameters: expect.arrayContaining([["rule_id", rule.id]]) })]);
    expect(policy.definition!.tests[0]!.context!.target_source).toBe("retrieved_content");
    expect(policy.protection.modelCapabilities).toEqual([]);
  });
  it("materializes pinned custom Policy defaults while preserving explicit values and the source draft", () => {
    const snapshot: ProgrammablePolicySnapshot = {
      ...programmablePolicyDraftSchema.parse({
        guardrail_category: "content_safety", sources: [{ path: "checks.co", content: 'flow check $text\n  $label = "${label}"\n  pass\n' }],
        parameter_schema: [
          { name: "label", kind: "string", required: true, default: "banking" },
          { name: "optional", kind: "string", default: "fallback" },
          { name: "unset", kind: "string" },
        ],
        rail_bindings: [{ rail_type: "input", flow_name: "check", execution_mode: "detect", on_unsafe: "block" }],
      }),
      policy_id: "parameterized", version: "1", name: "Parameters", description: "", source: "custom", owner: "test",
      checksum: "pinned", published_at: "2026-09-06",
    };
    const binding = { ...nativeBinding(snapshot.policy_id), policyVersion: "1",
      enabledRuleIds: ["flow/input/check"], enabledRails: ["input"], parameterValues: { optional: "" } };
    const draft = { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced" as const,
      outputDelivery: "full_buffered" as const, policyBindings: [binding] };
    const before = structuredClone({ snapshot, draft });
    const build = () => buildGuardrailPlan({ guardrailId: "parameters", guardrailVersion: "v1", draft, programmablePolicies: [snapshot] });
    expect(build).toThrow(/Rank Mode does not support custom Colang flows/);
    expect({ snapshot, draft }).toEqual(before);
  });

  it.each([
    "content-safety-model", "prompt-instruction-attacks", "pii-semantic",
  ])("compiles the catalog Rule override for %s without changing the source Policy", (id) => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const policy = policies.find((item) => item.id === id)!;
    const before = structuredClone(policy);
    const rule = policy.rules[0]!;
    const binding = {
      ...nativeBinding(id), policyVersion: policy.version,
      enabledRuleIds: [rule.id], enabledRails: [...policy.rails],
      action: "block" as const, ruleActions: { [rule.id]: "allow" as const },
    };
    const build = () => buildGuardrailPlan({
      guardrailId: "native-override", guardrailVersion: "20260906-010000.001Z", policies,
      draft: { allowedTopics: ["banking"], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered", policyBindings: [binding] },
    });
    const plan = build();
    const steps = plan.steps as Array<{ on_unsafe: string; phases: string[] }>;
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((step) => step.on_unsafe === "allow")).toBe(true);
    expect(steps.every((step) => step.phases.every((phase) => (policy.rails as string[]).includes(phase)))).toBe(true);
    expect(plan.policy_bindings).toEqual([expect.objectContaining({ rule_actions: [[rule.id, "allow"]], rule_severities: [[rule.id, rule.risk_severity]] })]);
    expect(policy).toEqual(before);
    binding.ruleActions = { missing: "allow" };
    expect(build).toThrow(/unknown Rule action overrides/);
  });

  it("carries the Policy-authored semantic PII definition into the executable plan", () => {
    // The semantic boundary belongs to the Policy package. The plan must ship the
    // resolved question, categories and criteria, not a Runner-owned copy.
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const policy = policies.find((item) => item.id === "pii-semantic")!;
    const rule = policy.rules[0]!;
    const questions = policy.parameters.find((item: { name: string }) => item.name === "questions")!.default!;
    const plan = buildGuardrailPlan({
      guardrailId: "pii-definition", guardrailVersion: "20261110-000000.000Z", policies,
      draft: { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered",
        policyBindings: [{ ...nativeBinding("pii-semantic"), policyVersion: policy.version,
          enabledRuleIds: [rule.id], enabledRails: ["input"], parameterValues: {} }] },
    });
    const step = (plan.steps as Array<{ parameters: Array<[string, string]> }>).find((item) =>
      item.parameters.some(([key]) => key === "rule_id"))!;
    const parameters = Object.fromEntries(step.parameters);
    expect(parameters.questions).toBe(questions);
    expect(parameters.questions).toContain("- id: contains_pii");
    expect(parameters.questions).toContain("{field}");
    expect(parameters.on_unknown).toBe("block");
  });

  it("rejects anonymous root rules instead of silently attaching or dropping them", () => {
    const draft = { ...defaultGuardrailDraft(PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list()), customContentRules: [{ id: "orphan" }] };
    expect(() => buildGuardrailPlan({ guardrailId: "orphan", guardrailVersion: "v1", draft })).toThrow(/Standalone custom content rules/);
  });

  it("preserves the exact catalog version, enabled Rules, parameters, and action overrides", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const plan = buildGuardrailPlan({
      guardrailId: "guardrail-rich",
      guardrailVersion: "20260904-040000.004Z",
      policies,
      draft: {
        allowedTopics: ["customer support"],
        restrictedTopics: ["credential sharing"],
        safetyLevel: "strict",
        outputDelivery: "full_buffered",
        policyBindings: [{
          policyId: "content-filters",
          policyVersion: "1.0.0",
          action: "block",
          parameterValues: { brand_name: "internal-only", competitors: "rival", phrase_entries: JSON.stringify([{ id: "p", phrase: "x", action: "block", replacement: "[REDACTED]" }]), blocked_words: "internal-only" },
          enabledRuleIds: ["keyword/blocked-words"],
          ruleActions: { "keyword/blocked-words": "transform" },
          enabledRails: ["input"],
          reasoningPolicy: null,
        }],
      },
    });

    expect(plan.policy_bindings).toEqual([expect.objectContaining({
      policy_id: "content-filters",
      policy_version: "1.0.0",
      action: "block",
      parameter_values: expect.arrayContaining([["blocked_words", "internal-only"]]),
      enabled_rule_ids: ["keyword/blocked-words"],
      rule_actions: [["keyword/blocked-words", "transform"]],
      enabled_rails: ["input"],
    })]);
    expect(plan.steps).toEqual([expect.objectContaining({
      capability: "builtin_content_filter",
      contract_ref: "tali.guard.content-filter.rules.v1",
      phases: ["input"],
      on_unsafe: "transform",
      parameters: expect.arrayContaining([
        ["policy_versions_json", JSON.stringify({ "content-filters": "1.0.0" })],
        ["enabled_rules_json", JSON.stringify({ "content-filters": ["keyword/blocked-words"] })],
        ["rule_actions_json", JSON.stringify({ "content-filters": { "keyword/blocked-words": "transform" } })],
      ]),
    })]);
  });

  it("rejects a stale catalog version before it can reach Runner", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    expect(() => buildGuardrailPlan({
      guardrailId: "guardrail-stale",
      guardrailVersion: "20260904-010000.001Z",
      policies,
      draft: {
        allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered",
        policyBindings: [{
          policyId: "content-filters", policyVersion: "0.0.1", action: null,
          parameterValues: { blocked_words: "blocked" }, enabledRuleIds: ["keyword/blocked-words"],
          ruleActions: {}, enabledRails: ["input"], reasoningPolicy: null,
        }],
      },
    })).toThrow(/unavailable/i);
  });

  it.each(["interruptible", "window_buffered", "full_buffered"] as const)(
    "preserves the %s output-delivery flag in the immutable Plan",
    (outputDelivery) => {
      const plan = buildGuardrailPlan({
        guardrailId: `guardrail-${outputDelivery}`,
        guardrailVersion: "20260904-010000.001Z",
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
      guardrailVersion: "20260904-020000.002Z",
      draft: {
        allowedTopics: [],
        restrictedTopics: [],
        safetyLevel: "balanced",
        outputDelivery: "full_buffered",
        policyBindings: [{
          ...nativeBinding("builtin-secrets"),
          action: "transform",
          enabledRails: ["output"],
        }],
      },
    });

    expect(plan.steps).toEqual([
      expect.objectContaining({ phases: ["output"], on_unsafe: "transform" }),
    ]);
    expect(plan.modules).toEqual([
      expect.objectContaining({ id: "data_protection:builtin-secrets:output", phase: "output" }),
    ]);
    expect(plan.policy_bindings).toEqual([
      expect.objectContaining({ action: "transform", enabled_rails: ["output"] }),
    ]);
  });

  it("keeps mixed-action catalog Rules together when a custom flow is present", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const contact = policies.find(item => item.id === "contact-data")!;
    const snapshot: ProgrammablePolicySnapshot = {
      ...programmablePolicyDraftSchema.parse({
        guardrail_category: "content_safety",
        sources: [{ path: "main.co", content: "flow inspect $text\n  pass" }],
        rail_bindings: [{ rail_type: "input", flow_name: "inspect", execution_mode: "detect", on_unsafe: "block" }],
      }),
      policy_id: "custom-inspect", version: "1", name: "Inspect", description: "",
      source: "custom", owner: "test", checksum: "test", published_at: "2026-10-23",
    };
    const order = ["pattern/email", "pattern/us_phone"];
    expect(() => buildGuardrailPlan({
      guardrailId: "custom-barrier", guardrailVersion: "20261023-000000.001Z",
      policies, programmablePolicies: [snapshot],
      draft: {
        allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered",
        policyBindings: [
          { ...nativeBinding(contact.id), policyVersion: contact.version, enabledRuleIds: order,
            enabledRails: ["input"], ruleOrder: order,
            ruleActions: { "pattern/email": "transform", "pattern/us_phone": "block" } },
          { ...nativeBinding(snapshot.policy_id), policyVersion: snapshot.version, enabledRuleIds: ["flow/input/inspect"],
            enabledRails: ["input"] },
        ],
      },
    })).toThrow(/Rank Mode does not support custom Colang flows/);
  });

  it("honors native Policy Rule overrides independently for input and output", () => {
    const snapshot: ProgrammablePolicySnapshot = {
      ...programmablePolicyDraftSchema.parse({
        guardrail_category: "content_safety",
        sources: [{ path: "main.co", content: "flow check_input $text\n  pass\nflow check_output $text\n  pass" }],
        rail_bindings: [
          { rail_type: "input", flow_name: "check_input", execution_mode: "detect", on_unsafe: "block" },
          { rail_type: "output", flow_name: "check_output", execution_mode: "detect", on_unsafe: "block" },
        ],
        execution_contract: [["native_risk", "content_safety"]],
      }),
      policy_id: "safety", version: "1", name: "Safety", description: "", source: "built_in", owner: "system",
      checksum: "test", published_at: "2026-09-02",
    };
    const binding = {
      ...nativeBinding("safety"), policyVersion: "1", action: "allow" as const,
      enabledRuleIds: ["flow/input/check_input", "flow/output/check_output"],
      enabledRails: ["input" as const, "output" as const],
      ruleActions: { "flow/output/check_output": "transform" as const },
    };
    const build = () => buildGuardrailPlan({
      guardrailId: "native", guardrailVersion: "20260904-010000.001Z", programmablePolicies: [snapshot],
      draft: { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered", policyBindings: [binding] },
    });
    expect(build().steps).toEqual([
      expect.objectContaining({ phases: ["input"], on_unsafe: "allow" }),
      expect.objectContaining({ phases: ["output"], on_unsafe: "transform" }),
    ]);
    binding.enabledRuleIds = ["flow/output/check_output"];
    expect(build().steps).toEqual([expect.objectContaining({ phases: ["output"], on_unsafe: "transform" })]);
  });


});

describe("Compiled evaluation views", () => {
  it("declares the authored precedence and a schedule-independent view per step", () => {
    const compiler = new DeclarativeCompiler(resolve("../runner/toolkit/policy_library/assets"));
    const template = compiler.shipped("content-filters")!;
    const definition = structuredClone(template);
    definition.metadata.id = "views";
    definition.metadata.version = "1.0.0";
    definition.parameters = [];
    delete definition.testing;
    definition.tests = [];
    definition.rules = [
      { ...structuredClone(template.rules[0]!), id: "mask", name: "Mask", stages: ["input", "output"],
        detector: { ref: "text/keyword", version: "1.0.0", parameters: { keywords: [["alpha", "low"]] } },
        on_match: { action: "transform", replacement: "[MASK]" }, runtime_adapter: undefined },
      { ...structuredClone(template.rules[0]!), id: "block", name: "Block", stages: ["input", "output"],
        detector: { ref: "text/keyword", version: "1.0.0", parameters: { keywords: [["alpha", "low"]] } },
        on_match: { action: "block" }, runtime_adapter: undefined },
    ];
    const policy = compiler.compile(definition);
    const plan = buildGuardrailPlan({ guardrailId: "views", guardrailVersion: "20261023-000000.001Z", policies: [policy],
      draft: { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered",
        policyBindings: [{ policyId: policy.id, policyVersion: policy.version, action: null, parameterValues: {},
          enabledRuleIds: ["mask", "block"], ruleOrder: ["mask", "block"], ruleActions: {}, enabledRails: ["input", "output"],
          reasoningPolicy: null }] } });
    const parameters = plan.steps.map((step) => Object.fromEntries(step.parameters));
    // Rank Mode executes authored Rule order and every step reads the content
    // produced by preceding Transforms.
    expect(plan.steps.map((step) => step.on_unsafe)).toEqual(["transform", "block"]);
    expect(parameters[0]).toMatchObject({ precedence: "0", evaluation_view: "previous_output" });
    expect(parameters[1]).toMatchObject({ precedence: "1", evaluation_view: "previous_output" });
    expect(parameters[0]!.execution_schedule).toBe("local-first");
    expect(parameters[1]!.execution_schedule).toBe("local-first");
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
