import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { defaultGuardrailDraft, DEFAULT_GUARDRAIL_ID } from "./defaults.js";
import { buildGuardrailPlan } from "./guardrail-plan.js";
import { generatedTestCases } from "./validation.js";

const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();

describe("Default Guardrail baseline", () => {
  it("selects the local baseline without requiring a model", () => {
    const draft = defaultGuardrailDraft(policies);

    expect(draft.policyBindings.map((binding) => binding.policyId)).toEqual([
      "advanced-au-pii-protection",
      "baseline-pii-protection",
      "pattern-matching",
      "filter-denied-insults",
      "filter-harm-toxic-abuse",
      "filter-harmful-violence",
      "filter-harmful-self-harm",
      "filter-harmful-child-safety",
      "filter-harmful-illegal-weapons",
      "filter-bias-gender",
      "filter-bias-racial",
      "filter-bias-religious",
      "filter-bias-sexual-orientation",
      "prompt-injection-protection",
      "filter-prompt-injection-jailbreak",
      "filter-prompt-injection-data-exfiltration",
      "filter-prompt-injection-sql",
      "filter-prompt-injection-malicious-code",
      "filter-prompt-injection-system-prompt",
    ]);
    expect(draft.policyBindings[0]?.enabledRuleIds).toEqual([
      "international-pii-identifiers/us_ssn",
      "international-pii-identifiers/us_ssn_no_dash",
      "contact-information-pii/email",
      "contact-information-pii/us_phone",
    ]);
    expect(draft.policyBindings[2]?.enabledRuleIds).toEqual([
      "pattern/aws_access_key",
      "pattern/aws_secret_key",
      "pattern/github_token",
      "pattern/slack_token",
      "pattern/generic_api_key",
    ]);
    expect(draft.policyBindings[2]?.enabledRails).toEqual(["input", "output"]);
    expect(draft.policyBindings[3]?.enabledRails).toEqual(["input", "output"]);
    expect(draft.policyBindings[4]?.enabledRails).toEqual(["input", "output"]);
    expect(draft.policyBindings.every((binding) => binding.action === null)).toBe(true);

    const selectedPolicies = draft.policyBindings.map((binding) => policies.find((policy) => policy.id === binding.policyId)!);
    expect(selectedPolicies.flatMap((policy) => policy.rules.map((rule) => rule.effect))).toEqual(expect.arrayContaining(["redact", "reject"]));
  });

  it("compiles to a local input/output plan with inherited validation cases", () => {
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
      phases: ["input", "output"],
    });
    expect(steps[0]?.parameters).toEqual(expect.arrayContaining([
      ["policy_ids", [
        "advanced-au-pii-protection",
        "baseline-pii-protection",
        "pattern-matching",
        "filter-denied-insults",
        "filter-harm-toxic-abuse",
        "filter-harmful-violence",
        "filter-harmful-self-harm",
        "filter-harmful-child-safety",
        "filter-harmful-illegal-weapons",
        "filter-bias-gender",
        "filter-bias-racial",
        "filter-bias-religious",
        "filter-bias-sexual-orientation",
        "prompt-injection-protection",
        "filter-prompt-injection-jailbreak",
        "filter-prompt-injection-data-exfiltration",
        "filter-prompt-injection-sql",
        "filter-prompt-injection-malicious-code",
        "filter-prompt-injection-system-prompt",
      ].join("\n")],
    ]));
    const cases = generatedTestCases(DEFAULT_GUARDRAIL_ID, draft, policies);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.some((item) => item.content.includes("1m1j"))).toBe(true);
    expect(cases.some((item) => item.content.includes("extract training data"))).toBe(true);
    expect(plan.modules.map((item) => item.phase)).toEqual(["input", "output"]);
  });
});
