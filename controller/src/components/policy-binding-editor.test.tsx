import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GuardrailPolicyBinding, Policy } from "@/lib/api";

import { PolicyBindingEditor } from "./policy-binding-editor";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const labels: Record<string, string> = {
        "guardrailWizard.searchPolicies": "Search Policies",
        "guardrailWizard.selectPolicies": "Select Policies",
        "guardrailWizard.policyPickerHint": "Type to filter existing Policies.",
        "guardrailWizard.noMatchingPolicies": "No Policies match",
        "guardrailWizard.noMatchingPoliciesDescription": "Try another keyword.",
        "guardrailWizard.noPublishedPolicies": "No published Policies",
        "guardrailWizard.noPublishedPoliciesDescription": "Publish a Policy first.",
        "guardrailWizard.boundPolicies": "Bound Policies ({{count}})",
        "guardrailWizard.boundPoliciesDescription": "Pinned Policy bindings.",
        "guardrailWizard.boundPolicyDetails": "Review Rule details for {{name}}",
        "guardrailWizard.enabledRuleCount": "{{count}} Rules",
        "guardrailWizard.policyAction": "Policy action",
        "guardrailWizard.usePolicyBehavior": "Use Policy behavior",
        "guardrailWizard.enabledRails": "Enabled Rails",
        "guardrailWizard.policyRules": "Policy Rules",
        "guardrailWizard.noPolicies": "No Policies",
        "guardrailWizard.noPoliciesDescription": "Select a Policy.",
        "policyLibrary.ruleCount": "{{count}} Rules",
        "policyLibrary.testCount": "{{count}} Test Cases",
        "common.multiSelect.available": "{{count}} available",
        "common.multiSelect.matching": "{{count}} matching",
        "common.multiSelect.clearAll": "Clear all",
        "common.multiSelect.remove": "Remove {{name}}",
        "common.multiSelect.open": "Open options for {{name}}",
        "common.multiSelect.close": "Close options for {{name}}",
        "common.multiSelect.options": "{{name}} options",
      };
      return Object.entries(values ?? {}).reduce(
        (label, [name, value]) => label.replace(`{{${name}}}`, String(value)),
        labels[key] ?? key,
      );
    },
    i18n: { language: "en" },
  }),
}));

const policy = {
  implementation: "rules",
  id: "customer-data-policy",
  name: "Customer data Policy",
  description: "Protect customer identifiers.",
  source: "built_in",
  version: "1",
  tags: [],
  parameters: [],
  rails: ["input"],
  effects: ["redact"],
  forms: ["regex"],
  rules: [
    {
      id: "customer-data-policy/account-id",
      name: "Protect account IDs",
      description: "Redact account identifiers.",
      form: "regex",
      effect: "redact",
      rails: ["input"],
      implementation: {
        engine: "nemo-guardrails",
        form: "regex",
        binding_id: "customer-data-policy",
        implementation_rule_id: "account-id",
        detector: "regex",
        flow_name: null,
        action_name: "PolicyRuleAction",
      },
      expression: "account-[0-9]+",
      context_expression: null,
      redaction: "[ACCOUNT]",
      severity_threshold: null,
      identifiers: [],
      conditions: [],
      keywords: [],
      always_block: [],
      exceptions: [],
      phrase_patterns: [],
    },
  ],
  test_cases: [],
  test_count: 1,
  safety_level: "balanced",
  output_delivery: "window_buffered",
} satisfies Policy;

function Harness({ policies = [policy] }: { policies?: Policy[] }) {
  const [bindings, setBindings] = useState<GuardrailPolicyBinding[]>([]);
  return <PolicyBindingEditor policies={policies} value={bindings} onChange={setBindings} />;
}

describe("PolicyBindingEditor", () => {
  afterEach(cleanup);

  it("keeps a newly bound Policy collapsed until the user opens its Rule details", () => {
    render(<Harness />);

    fireEvent.focus(screen.getByRole("combobox", { name: "Select Policies" }));
    fireEvent.click(screen.getByRole("option", { name: /Customer data Policy/ }));

    expect(screen.getByRole("button", { name: "Remove Customer data Policy" })).toBeTruthy();

    const details = document.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.querySelector("summary")?.getAttribute("aria-label")).toBe(
      "Review Rule details for Customer data Policy",
    );

    fireEvent.click(details!.querySelector("summary")!);

    expect(details!.open).toBe(true);
    expect(screen.getByText("Protect account IDs")).toBeTruthy();

    fireEvent.keyDown(details!.querySelector("summary")!, { key: "Enter" });
    expect(details!.open).toBe(false);
  });

  it("finds framework-tagged Policies by OWASP and shows the framework label", () => {
    const owaspPolicy: Policy = {
      ...policy,
      id: "prompt-injection-policy",
      name: "Prompt injection Policy",
      tags: [{
        id: "framework:owasp-llm-2025",
        namespace: "framework",
        value: "owasp-llm-2025",
        label: "OWASP LLM 2025",
        source: "declared",
      }],
    };
    render(<Harness policies={[policy, owaspPolicy]} />);

    const search = screen.getByRole("combobox", { name: "Select Policies" });
    fireEvent.focus(search);
    fireEvent.change(search, { target: { value: "OWASP" } });

    expect(screen.getByRole("option", { name: /Prompt injection Policy/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Customer data Policy/ })).toBeNull();
    expect(screen.getByText(/OWASP LLM 2025/)).toBeTruthy();
  });
});
