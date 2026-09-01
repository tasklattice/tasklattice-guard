import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { defaultGuardrailDraft, DEFAULT_GUARDRAIL_ID } from "./defaults.js";
import { buildGuardrailPlan } from "./guardrail-plan.js";
import { generatedTestCases } from "./validation.js";

const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();

describe("Default Guardrail baseline", () => {
  it("selects only local input Policies and preserves their Rule-level effects", () => {
    const draft = defaultGuardrailDraft(policies);

    expect(draft.policyBindings.map((binding) => binding.policyId)).toEqual([
      "advanced-au-pii-protection",
      "baseline-pii-protection",
      "prompt-injection-protection",
    ]);
    expect(draft.policyBindings[0]?.enabledRuleIds).toEqual([
      "international-pii-identifiers/us_ssn",
      "international-pii-identifiers/us_ssn_no_dash",
      "contact-information-pii/email",
      "contact-information-pii/us_phone",
    ]);
    expect(draft.policyBindings.every((binding) => binding.enabledRails.length === 1 && binding.enabledRails[0] === "input")).toBe(true);
    expect(draft.policyBindings.every((binding) => binding.action === null)).toBe(true);

    const selectedPolicies = draft.policyBindings.map((binding) => policies.find((policy) => policy.id === binding.policyId)!);
    expect(selectedPolicies.flatMap((policy) => policy.rules.map((rule) => rule.effect))).toEqual(expect.arrayContaining(["redact", "reject"]));
  });

  it("compiles to a local input-only evaluation plan with inherited validation cases", () => {
    const draft = defaultGuardrailDraft(policies);
    const plan = buildGuardrailPlan({
      guardrailId: DEFAULT_GUARDRAIL_ID,
      guardrailVersion: 1,
      purpose: "Protect unmatched traffic locally.",
      draft,
      policies,
    });
    const steps = plan.steps as Array<{ capability: string; contract_ref: string; phases: string[]; parameters: Array<[string, string]> }>;

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      capability: "builtin_content_filter",
      contract_ref: "tali.guard.content-filter.rules.v1",
      phases: ["input"],
    });
    expect(steps[0]?.parameters).toEqual(expect.arrayContaining([
      ["policy_ids", "advanced-au-pii-protection\nbaseline-pii-protection\nprompt-injection-protection"],
    ]));
    const cases = generatedTestCases(DEFAULT_GUARDRAIL_ID, draft, policies);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((item) => item.phase === "input")).toBe(true);
  });
});
