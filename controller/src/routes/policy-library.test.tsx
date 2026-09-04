import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Policy } from "@/lib/api";

import { DeletePolicyDialog, PolicyCard, PolicyDetail, TagFilters } from "./policy-library";

vi.mock("@/components/policy-studio", () => ({ PolicyStudioSheet: () => null }));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const labels: Record<string, string> = {
        "common.close": "Close",
        "policyLibrary.detailEyebrow": "Policy Library / Policy",
        "policyLibrary.sourceLabels.custom": "Custom Policy",
        "policyLibrary.sourceLabels.built_in": "Built-in",
        "policyLibrary.exportAction": "Export",
        "policyLibrary.exportPolicyAria": "Export {{name}} migration package",
        "policyLibrary.deleteAction": "Delete Policy",
        "policyLibrary.deletePolicyAria": "Delete {{name}}",
        "policyLibrary.deleteDialogTitle": "Delete custom Policy?",
        "policyLibrary.deleteDialogDescription": "Permanently delete {{name}}.",
        "policyLibrary.deleteDialogGuardrailNote": "Referenced Guardrail drafts block deletion.",
        "policyLibrary.deleteConfirm": "Delete permanently",
        "policyLibrary.deleting": "Deleting…",
        "policyLibrary.inspectPolicy": "Inspect",
        "policyLibrary.rules": "Rules",
        "policyLibrary.testCases": "Test Cases",
        "policyLibrary.detailViews": "Policy detail views",
        "policyLibrary.tabs.policy": "Policy",
        "policyLibrary.tabs.testCases": "Test Cases",
        "policyLibrary.tabs.implementation": "NeMo implementation",
        "policyLibrary.ruleListTitle": "Rules ({{count}})",
        "policyLibrary.ruleListDescription": "Each Rule is linked to Test Cases.",
        "policyLibrary.testCasesTitle": "Test Cases ({{count}})",
        "policyLibrary.testCasesDescription": "Executable Test Cases.",
        "policyLibrary.implementationTitle": "NeMo Guardrails implementation",
        "policyLibrary.implementationDescription": "Technical Rule bindings.",
        "policyLibrary.filters": "Filters",
        "policyLibrary.clearFilters": "Clear filters",
        "policyLibrary.tagNamespaces.implementation": "Implementation",
        "policyLibrary.tagNamespaces.rail": "Rail type",
        "policyLibrary.railTypesLabel": "Rail types",
        "policyLibrary.ruleForms": "Rule forms",
        "policyLibrary.ruleForm": "Rule form",
        "policyLibrary.effectLabel": "Effect",
        "policyLibrary.runtimeManaged": "Runtime managed",
        "policyLibrary.jurisdictions.au": "Australia",
        "policyLibrary.forms.category": "Category",
        "policyLibrary.railTypes.input": "Input rail",
        "policyLibrary.railTiming.input": "Before the main model",
        "policyLibrary.effects.block": "Block",
        "policyLibrary.testKinds.rule_acceptance": "Rule acceptance",
        "policyLibrary.testKinds.scenario": "Policy scenario",
        "policyLibrary.expectedDecisions.allow": "Should allow",
        "policyLibrary.expectedDecisions.block": "Should block",
        "policyLibrary.coveredRules": "Covered Rules",
      };
      return Object.entries(values ?? {}).reduce(
        (label, [name, value]) => label.replace(`{{${name}}}`, String(value)),
        labels[key] ?? key,
      );
    },
  }),
}));

const policy: Policy = {
  implementation: "rules",
  id: "competitor-policy",
  name: "Competitor Discussion Policy",
  description: "Blocks competitor comparisons while allowing destination questions.",
  source: "built_in",
  version: "1.0.0",
  tags: [
    { id: "guardrail_category:topic_control", namespace: "guardrail_category", value: "topic_control", label: "Topic Control", source: "declared" },
    { id: "jurisdiction:au", namespace: "jurisdiction", value: "au", label: "Australia", source: "declared" },
    { id: "implementation:category", namespace: "implementation", value: "category", label: "Category classifier", source: "derived" },
    { id: "rail:input", namespace: "rail", value: "input", label: "Input rail", source: "derived" },
  ],
  parameters: [],
  rails: ["input"],
  effects: ["block"],
  forms: ["category"],
  rules: [{
    id: "competitor-policy/comparison-intent",
    name: "Competitor comparison intent",
    description: "Requires a competitor identity and comparison intent.",
    form: "category",
    effect: "block",
    rails: ["input"],
    implementation: {
      engine: "nemo-guardrails",
      form: "category",
      binding_id: "competitor-policy",
      implementation_rule_id: "comparison-intent",
      detector: "category",
      flow_name: null,
      action_name: "GuardPolicyRuleAction",
    },
    expression: null,
    context_expression: null,
    redaction: null,
    severity_threshold: null,
    identifiers: ["airline"],
    conditions: ["compare"],
    keywords: [],
    always_block: [],
    exceptions: [],
    phrase_patterns: [],
  }],
  test_count: 2,
  test_cases: [{
      id: "comparison-block",
      name: "Block airline comparison",
      description: "Proves the Rule can block.",
      phase: "input",
      content: "Compare these two airlines.",
      expected_decision: "block",
      covered_rule_ids: ["competitor-policy/comparison-intent"],
      group: "Rule acceptance",
      kind: "rule_acceptance",
      required: true,
      parameter_names: [],
    }, {
      id: "destination-allow",
      name: "Allow destination question",
      description: "Destination questions are not comparisons.",
      phase: "input",
      content: "Do you have flights to Qatar?",
      expected_decision: "allow",
      covered_rule_ids: ["competitor-policy/comparison-intent"],
      group: "Destination intent",
      kind: "scenario",
      required: true,
      parameter_names: [],
    }],
  safety_level: "balanced",
  output_delivery: "window_buffered",
};

function clickTab(tab: HTMLElement) {
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.mouseUp(tab, { button: 0, ctrlKey: false });
  fireEvent.click(tab);
}

describe("Policy detail", () => {
  afterEach(cleanup);

  it("presents Policy, testable Rules, Test Cases, and NeMo implementation as three views", () => {
    render(<PolicyDetail policy={policy} onClose={vi.fn()} onEdit={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Competitor Discussion Policy" })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Policy detail views" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Policy" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByText("Input rail").length).toBeGreaterThan(0);
    expect(screen.getByText("Australia").parentElement?.textContent).toBe("🇦🇺Australia");
    expect(screen.queryByText("Category classifier")).toBeNull();
    expect(screen.getByText("Rules (1)")).toBeTruthy();
    expect(screen.getByText("Competitor comparison intent")).toBeTruthy();

    clickTab(screen.getByRole("tab", { name: "Test Cases" }));
    expect(screen.getByText("Test Cases (2)")).toBeTruthy();
    expect(screen.getByText("Block airline comparison")).toBeTruthy();
    expect(screen.getByText("Allow destination question")).toBeTruthy();

    clickTab(screen.getByRole("tab", { name: "NeMo implementation" }));
    expect(screen.getByRole("heading", { name: "NeMo Guardrails implementation" })).toBeTruthy();
    expect(screen.queryByText("Runtime engine")).toBeNull();
    const actionName = screen.getByText("GuardPolicyRuleAction");
    expect(actionName.tagName).toBe("CODE");
    expect(actionName.getAttribute("title")).toBe("GuardPolicyRuleAction");
  });

  it("visually identifies a custom Policy and exposes its migration export from the card", () => {
    const onExport = vi.fn();
    const onDelete = vi.fn();
    const customPolicy: Policy = {
      ...policy,
      id: "customer-identifiers",
      name: "Customer identifiers",
      source: "custom",
      implementation: "nemo_native",
    };

    render(<PolicyCard policy={customPolicy} onOpen={vi.fn()} onExport={onExport} onDelete={onDelete} />);

    expect(screen.getByText("Custom Policy")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export Customer identifiers migration package" }));
    expect(onExport).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Delete Customer identifiers" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("does not expose deletion for a built-in Policy", () => {
    render(<PolicyCard policy={policy} onOpen={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Delete Competitor Discussion Policy" })).toBeNull();
    const heading = screen.getByRole("heading", { name: "Competitor Discussion Policy" });
    expect(heading.parentElement?.textContent).toContain("Built-in");
    expect(heading.closest("article")?.querySelectorAll(".lucide-shield-check")).toHaveLength(1);
  });

  it("requires explicit confirmation before deleting a custom Policy", () => {
    const onConfirm = vi.fn();
    const customPolicy: Policy = {
      ...policy,
      id: "customer-identifiers",
      name: "Customer identifiers",
      source: "custom",
      implementation: "nemo_native",
    };

    render(<DeletePolicyDialog policy={customPolicy} deleting={false} error={null} onCancel={vi.fn()} onConfirm={onConfirm} />);

    expect(screen.getByRole("dialog", { name: "Delete custom Policy?" })).toBeTruthy();
    expect(screen.getByText("Permanently delete Customer identifiers.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("omits technical implementation and Rail classifications from user-facing filters", () => {
    const onChange = vi.fn();
    const railTag = policy.tags.find((tag) => tag.namespace === "rail");
    const implementationTag = policy.tags.find((tag) => tag.namespace === "implementation");
    if (!railTag || !implementationTag) throw new Error("Technical tag fixtures are required");

    render(<TagFilters facets={new Map([["implementation", [implementationTag]], ["rail", [railTag]]])} selected={new Set()} onChange={onChange} />);

    expect(screen.queryByText("Implementation")).toBeNull();
    expect(screen.queryByRole("button", { name: /Category classifier/ })).toBeNull();
    expect(screen.queryByText("Rail type")).toBeNull();
    expect(screen.queryByRole("button", { name: /Input rail/ })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
