import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { buildGuardrailPlan } from "./guardrail-plan.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { programmablePolicyDraftSchema, type ProgrammablePolicySnapshot } from "../policy-studio/model.js";
import { defaultGuardrailDraft } from "./defaults.js";
import { DeclarativeCompiler } from "../policy-studio/declarative.js";

describe("Controller Guardrail plan", () => {
  it.each([
    ["builtin-indirect-prompt-injection", "indirect_prompt_injection", "tali.guard.indirect-prompt-injection.v1"],
    ["builtin-memory-poisoning", "memory_poisoning", "tali.guard.memory-poisoning.v1"],
  ])("keeps the boundary Action when %s is authored as a custom Policy", (id, capability, contract) => {
    const compiler = new DeclarativeCompiler(resolve("../runner/toolkit/policy_library/assets"));
    const definition = compiler.shipped(id!)!;
    definition.metadata.id = `custom-${capability}`;
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
  it("rejects a classifier change that the native adapter cannot execute", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const policy = policies.find(item => item.id === "builtin-content-safety")!;
    policy.rules[0]!.detector_options = { profile: "topic-classification" };
    const binding = { ...nativeBinding(policy.id), policyVersion: policy.version,
      enabledRuleIds: policy.rules.map(rule => rule.id), enabledRails: ["input"] };
    expect(() => buildGuardrailPlan({ guardrailId: "invalid-profile", guardrailVersion: "v1", policies,
      draft: { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered", policyBindings: [binding] },
    })).toThrow("requires the safety-classification detector contract");
  });
  it("pins local Rule definitions and parameter defaults without changing the source Policy", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const policy = policies.find(item => item.id === "keyword-blocking")!;
    policy.parameters[0]!.default = "private";
    const before = structuredClone(policy);
    const binding = { ...nativeBinding(policy.id), policyVersion: policy.version,
      enabledRuleIds: policy.rules.map(rule => rule.id), enabledRails: ["input"] as const };
    const build = () => buildGuardrailPlan({ guardrailId: "pinned", guardrailVersion: "v1", policies,
      draft: { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered", policyBindings: [{ ...binding, enabledRails: [...binding.enabledRails] }] } });
    const plan = build();
    const parameters = Object.fromEntries((plan.steps as Array<{ parameters: Array<[string, string]> }>)[0]!.parameters);
    const pinned = JSON.parse(parameters.policy_definitions_json!)[policy.id];
    expect(pinned.rules).toEqual(before.rules);
    expect(pinned.version).toBe(before.version);
    expect(JSON.parse(parameters.policy_parameters_json!)).toEqual({ [policy.id]: { blocked_words: "private" } });
    expect(policy).toEqual(before);
    policy.rules[0]!.effect = "allow";
    expect(pinned.rules[0].effect).toBe(before.rules[0]!.effect);
    expect(build()).not.toEqual(plan);
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
    expect(build().policy_bindings).toEqual([expect.objectContaining({ parameter_values: [["label", "banking"], ["optional", ""]] })]);
    expect({ snapshot, draft }).toEqual(before);
    Object.assign(binding.parameterValues, { label: "securities" });
    expect(build().policy_bindings).toEqual([expect.objectContaining({ parameter_values: [["label", "securities"], ["optional", ""]] })]);
  });

  it.each([
    "builtin-content-safety", "builtin-jailbreak", "builtin-pii",
    "builtin-contextual-grounding", "builtin-automated-reasoning",
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

  it("inherits the native catalog Rule effect when no local action is configured", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const policy = policies.find((item) => item.id === "builtin-pii")!;
    const plan = buildGuardrailPlan({ guardrailId: "native-default", guardrailVersion: "20260906-010000.001Z", policies,
      draft: { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered",
        policyBindings: [{ ...nativeBinding(policy.id), policyVersion: policy.version, enabledRuleIds: [policy.rules[0]!.id], enabledRails: ["output"] }] },
    });
    expect(plan.steps).toEqual([
      expect.objectContaining({ on_unsafe: "transform", phases: ["output"] }),
      expect.objectContaining({ on_unsafe: "transform", phases: ["output"] }),
    ]);
  });

  it("rejects an unsupported Rail instead of silently compiling empty protection", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const policy = policies.find((item) => item.id === "builtin-jailbreak")!;
    const draft = {
      allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced" as const, outputDelivery: "full_buffered" as const,
      policyBindings: [{ ...nativeBinding(policy.id), policyVersion: policy.version, enabledRuleIds: policy.rules.map((rule) => rule.id), enabledRails: ["output"] as Array<"output"> }],
    };
    expect(() => buildGuardrailPlan({ guardrailId: "invalid", guardrailVersion: "v1", draft, policies })).toThrow(/unsupported Rail/);
  });
  it("rejects anonymous root rules instead of silently attaching or dropping them", () => {
    const draft = { ...defaultGuardrailDraft(PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list()), customContentRules: [{ id: "orphan" }] };
    expect(() => buildGuardrailPlan({ guardrailId: "orphan", guardrailVersion: "v1", draft })).toThrow(/Standalone custom content rules/);
  });

  it("preserves independent Policy and Rule ordering in the executable and immutable contracts", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const draft = defaultGuardrailDraft(policies);
    const template = structuredClone(policies);
    const binding = draft.policyBindings.find((item) => item.policyId === "local-contact-data")!;
    const build = () => buildGuardrailPlan({ guardrailId: "ordered", guardrailVersion: "20260904-010000.001Z", draft, policies });
    binding.ruleOrder = ["pattern/email", "pattern/us_phone"];
    const first = build();
    binding.ruleOrder.reverse();
    const second = build();
    expect(second).not.toEqual(first);
    const steps = second.steps as Array<{ parameters: Array<[string, string]> }>;
    const configured = steps.map((step) => Object.fromEntries(step.parameters)).find((item) => item.policy_ids === binding.policyId)!;
    expect(JSON.parse(configured.rule_order_json!)).toEqual({ "local-contact-data": ["pattern/us_phone", "pattern/email"] });
    expect((second.policy_bindings as Array<{ policy_id: string; rule_order?: string[] }>).find((item) => item.policy_id === binding.policyId)?.rule_order).toEqual(binding.ruleOrder);
    const previousOrder = draft.policyBindings.map((item) => item.policyId);
    draft.policyBindings.reverse();
    expect((build().policy_bindings as Array<{ policy_id: string }>).map((item) => item.policy_id)).toEqual(previousOrder.reverse());
    expect(policies).toEqual(template);
    binding.ruleOrder = ["pattern/email", "pattern/email"];
    expect(build).toThrow(/duplicate Rules/);
    binding.ruleOrder = ["missing"];
    expect(build).toThrow(/unknown ordered Rules/);
  });
  it("turns product Policy bindings into an immutable evaluator contract graph", () => {
    const plan = buildGuardrailPlan({
      guardrailId: "guardrail-1",
      guardrailVersion: "20260904-030000.003Z",
      draft: {
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
      guardrail_version: "20260904-030000.003Z",
      compiler_version: "tasklattice-controller-plan-v16-explicit-views",
      safety_level: "strict",
    });
    expect(plan.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "secrets", contract_ref: "tali.guard.secrets.exact.v1", on_unsafe: "block", trigger: { type: "always" } }),
      expect.objectContaining({ capability: "pii", contract_ref: "tali.guard.pii.exact.v1", trigger: { type: "always" } }),
      expect.objectContaining({ capability: "pii", contract_ref: "tali.guard.pii.semantic.v1", trigger: { type: "always" } }),
      expect.objectContaining({ capability: "prompt_injection", contract_ref: "tali.guard.prompt-injection.v1", on_unsafe: "block" }),
    ]));
    expect(plan.modules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "data_protection:builtin-pii:input", failure_mode: "fail_closed", timeout_ms: 30_000 }),
      expect.objectContaining({ id: "interaction_safety:builtin-prompt-injection:input", failure_mode: "fail_closed" }),
    ]));

    const balanced = buildGuardrailPlan({
      guardrailId: "guardrail-balanced",
      guardrailVersion: "20260904-010000.001Z",
      draft: {
        allowedTopics: [], restrictedTopics: [],
        policyBindings: [nativeBinding("builtin-pii")],
        safetyLevel: "balanced", outputDelivery: "full_buffered",
      },
    });
    expect(balanced.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        contract_ref: "tali.guard.pii.semantic.v1",
        trigger: { type: "always" },
      }),
    ]));
    // Exact and semantic checks share source parameters, not mutable metadata.
    expect(balanced.steps.map(step => Object.fromEntries(step.parameters).precedence)).toEqual(["0", "1"]);
    expect(balanced.steps.every(step => step.parameters.filter(([key]) => key === "precedence").length === 1)).toBe(true);
    expect(balanced.steps[0]!.parameters).not.toBe(balanced.steps[1]!.parameters);
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
          policyId: "keyword-blocking",
          policyVersion: "1.95.0",
          action: "block",
          parameterValues: { blocked_words: "internal-only" },
          enabledRuleIds: ["keyword/blocked-words"],
          ruleActions: { "keyword/blocked-words": "transform" },
          enabledRails: ["input"],
          reasoningPolicy: null,
        }],
      },
    });

    expect(plan.policy_bindings).toEqual([expect.objectContaining({
      policy_id: "keyword-blocking",
      policy_version: "1.95.0",
      action: "block",
      parameter_values: [["blocked_words", "internal-only"]],
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
        ["policy_versions_json", JSON.stringify({ "keyword-blocking": "1.95.0" })],
        ["enabled_rules_json", JSON.stringify({ "keyword-blocking": ["keyword/blocked-words"] })],
        ["rule_actions_json", JSON.stringify({ "keyword-blocking": { "keyword/blocked-words": "transform" } })],
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
          policyId: "keyword-blocking", policyVersion: "0.0.1", action: null,
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

  it("schedules effective Block Rules before transforms and preserves Rule > Policy > template actions", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const pattern = policies.find((item) => item.id === "local-contact-data")!;
    const keyword = policies.find((item) => item.id === "keyword-blocking")!;
    const makeBinding = (policy: typeof pattern) => ({
      ...nativeBinding(policy.id), policyVersion: policy.version,
      enabledRuleIds: policy.rules.map((item) => item.id), enabledRails: [...policy.rails],
    });
    const draft = {
      allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced" as const, outputDelivery: "full_buffered" as const,
      policyBindings: [
        { ...makeBinding(pattern), action: "block" as const, ruleActions: { "pattern/email": "transform" as const } },
        nativeBinding("builtin-secrets"),
        { ...makeBinding(keyword), parameterValues: { blocked_words: "private" }, enabledRails: ["output" as const] },
      ],
    };
    const plan = buildGuardrailPlan({ guardrailId: "ordered", guardrailVersion: "20260904-010000.001Z", draft, policies: [...policies, {
      ...keyword, id: "builtin-secrets", version: "1.0.0", parameters: [], rules: [{ ...keyword.rules[0]!, id: "builtin-secrets" }],
    }] });
    const steps = plan.steps as Array<{ parameters: Array<[string, string]>; phases: string[] }>;
    expect(steps.map((item) => Object.fromEntries(item.parameters).policy_id)).toEqual([
      "local-contact-data", "builtin-secrets", "keyword-blocking", "local-contact-data",
    ]);
    const actions = JSON.parse(Object.fromEntries(steps[0]!.parameters).rule_actions_json!)[pattern.id];
    expect(actions["pattern/email"]).toBeUndefined();
    expect(JSON.parse(Object.fromEntries(steps[3]!.parameters).rule_actions_json!)[pattern.id]["pattern/email"]).toBe("transform");
    expect(actions["pattern/us_phone"]).toBe("block");
    expect(steps[2]!.phases).toEqual(["output"]);
    const modules = plan.modules as Array<{ id: string; phase: string; depends_on: string[]; input_view: string }>;
    for (const phase of ["input", "output"]) {
      const ordered = modules.filter((item) => item.phase === phase);
      ordered.forEach((item, index) => {
        expect(item.input_view).toBe("previous_output");
        expect(item.depends_on).toEqual(index ? [ordered[index - 1]!.id] : []);
      });
    }
    expect(pattern.rules.find((item) => item.id === "pattern/us_phone")?.effect).toBe("transform");
    expect(draft.policyBindings[0]!.ruleActions).toEqual({ "pattern/email": "transform" });
  });

  it("keeps mixed-action catalog Rules together when a custom flow is present", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const contact = policies.find(item => item.id === "local-contact-data")!;
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
    const plan = buildGuardrailPlan({
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
    });
    const steps = plan.steps as Array<{ parameters: Array<[string, string]> }>;
    expect(steps).toHaveLength(1);
    const params = Object.fromEntries(steps[0]!.parameters);
    expect(JSON.parse(params.enabled_rules_json!)[contact.id]).toEqual(order);
    expect(JSON.parse(params.rule_order_json!)[contact.id]).toEqual(order);
    expect(params.execution_schedule).toBeUndefined();
    expect(params.evaluation_view).toBe("previous_output");
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
      expect.objectContaining({ phases: ["output"], on_unsafe: "transform" }),
      expect.objectContaining({ phases: ["input"], on_unsafe: "allow" }),
    ]);
    binding.enabledRuleIds = ["flow/output/check_output"];
    expect(build().steps).toEqual([expect.objectContaining({ phases: ["output"], on_unsafe: "transform" })]);
  });

  it("compiles Topic Control as a strict allowlist and rejects an empty allowlist", () => {
    const draft = {
      allowedTopics: ["Order status", "Returns"],
      restrictedTopics: ["legacy deny-list value"],
      safetyLevel: "balanced" as const,
      outputDelivery: "full_buffered" as const,
      policyBindings: [nativeBinding("builtin-topic-safety")],
    };
    const plan = buildGuardrailPlan({
      guardrailId: "topic-allowlist",
      guardrailVersion: "20260905-010000.001Z",
      draft,
    });
    const parameters = Object.fromEntries((plan.steps as Array<{ parameters: Array<[string, string]> }>)[0]!.parameters);
    expect(plan).toMatchObject({ topic_control_mode: "strict" });
    expect(parameters).toMatchObject({ topic_mode: "strict", allowed_topics: "Order status\nReturns" });
    expect(parameters.restricted_topics).toBe("legacy deny-list value");
    expect(Object.keys(parameters).some((key) => key.startsWith("purpose"))).toBe(false);

    const permissive = buildGuardrailPlan({ guardrailId: "permissive", guardrailVersion: "20260905-010000.001Z", draft: { ...draft, topicControlMode: "permissive", allowedTopics: [] } });
    expect(permissive.topic_control_mode).toBe("permissive");
    expect(Object.fromEntries(permissive.steps[0]!.parameters)).toMatchObject({ topic_mode: "permissive", restricted_topics: "legacy deny-list value" });

    draft.allowedTopics = [];
    expect(() => buildGuardrailPlan({ guardrailId: "topic-allowlist", guardrailVersion: "20260905-010000.001Z", draft }))
      .toThrow(/requires at least one allowed topic/i);
  });
});

describe("Compiled evaluation views", () => {
  it("declares the authored precedence and a schedule-independent view per step", () => {
    const compiler = new DeclarativeCompiler(resolve("../runner/toolkit/policy_library/assets"));
    const template = compiler.shipped("keyword-blocking")!;
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
    const parameters = Object.fromEntries(plan.steps.map((step) => [step.id.split(":")[2]!, Object.fromEntries(step.parameters)]));
    // Block is scheduled first for latency, yet its authored precedence stays last.
    expect(plan.steps.map((step) => step.on_unsafe)).toEqual(["block", "transform"]);
    expect(parameters.mask).toMatchObject({ precedence: "0", evaluation_view: "previous_output" });
    expect(parameters.block).toMatchObject({ precedence: "1", evaluation_view: "original" });
    expect(parameters.mask!.execution_schedule).toBe("block-first-v1");
    expect(parameters.block!.execution_schedule).toBe("block-first-v1");
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
