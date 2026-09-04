import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { TestCaseResult, ValidationRun } from "@/lib/api";
import { TooltipProvider } from "@/components/ui/tooltip";

import { DetailFact, filterValidationRuns, GuardrailValidationHistory, TestCaseResultRow, ValidationCaseResults } from "./validation";

vi.mock("@/components/add-test-case-sheet", () => ({ AddTestCaseSheet: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      "validation.caseTypes.scenario": "Policy scenario",
      "validation.acceptanceProvenance": "Acceptance provenance",
      "validation.sourcePolicy": "Pinned Policy",
      "validation.sourceTestCase": "Source Test Case",
      "validation.coveredRules": "Contract Rules",
      "validation.matchedRules": "Actually matched Rules",
      "validation.noRulesMatched": "No covered Rule matched",
      "validation.metricDefinition": "Pass rate definition",
      "validation.caseResults": "Case results",
      "validation.failuresFirst": "Failed cases are highlighted and listed first.",
      "validation.filterCaseResults": "Filter Case results",
      "validation.caseFilters.all": "All",
      "validation.caseFilters.failed": "Failed",
      "validation.caseFilters.passed": "Passed",
      "validation.whyCaseFailed": "Why this Case failed",
      "validation.decisionMismatch": "Decision mismatch",
      "validation.ruleMismatch": "Rule contract mismatch",
      "validation.validationContractMismatch": "Validation contract mismatch",
      "validation.validationRunColumn": "Validation Run",
      "validation.targetColumn": "Target",
      "validation.casesColumn": "Cases",
      "validation.statusColumn": "Status",
      "validation.passRateColumn": "Pass rate",
      "validation.durationColumn": "Duration",
      "validation.runAtColumn": "Run at",
      "validation.openValidationRun": "Open Validation Run",
      "guardrails.validationHistoryTitle": "Validation history",
      "guardrails.validationHistoryDescription": "Immutable release-gate evidence.",
      "guardrails.runReviewed": "Run Validation",
      "validation.versionTarget": "Guardrail Version 20260904-010000.001Z",
      "guardrails.expectedDecision": "Expected decision",
      "guardrails.actualDecision": "Actual decision",
    } as Record<string, string>)[key] ?? key,
    i18n: { language: "en", exists: () => false },
  }),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));

const result: TestCaseResult = {
  case_id: "validation-case-1",
  name: "Competitor comparison",
  policy_id: "competitor-mention-detection",
  expected_decision: "block",
  actual_decision: "block",
  passed: false,
  evaluator_ids: ["local-rules"],
  evaluation_contracts: ["tali.guard.content-filter.rules.v1"],
  escalated: false,
  model_invocations: 0,
  latency_ms: 7,
  reason: "Matched the pinned Rule contract.",
  phase: "input",
  input_content: "Is Qatar Airways better than Emirates?",
  action: "reject",
  output_content: "",
  findings: [],
  trace: [],
  trusted_instruction: "",
  target_source: "user_input",
  query: "",
  grounding_sources: [],
  expected_reasoning_result: null,
  actual_reasoning_result: null,
  case_type: "scenario",
  required: true,
  expected_failure: null,
  actual_failure: null,
  concurrency_group: null,
  source_policy_id: "competitor-comparison-input-filter",
  source_policy_version: "1.95.0",
  source_case_id: "competitor-comparison-002",
  covered_rule_ids: ["competitor-comparison-intent"],
  matched_rule_ids: ["competitor-comparison-intent"],
};

const validationRun = {
  id: "validation-finance-001",
  guardrail_id: "guardrail-finance",
  guardrail_version: "20260904-010000.001Z",
  source_draft_version: 1,
  status: "passed",
  metrics: { total: 1, passed: 1, compliance_rate: 100, false_positive_rate: 0, false_negative_rate: 0, escalation_rate: 0, p95_latency_ms: 7 },
  results: [],
  excluded_case_ids: [],
  created_at: "2026-08-14T08:00:00Z",
} satisfies ValidationRun;

describe("Validation Run acceptance evidence", () => {
  beforeAll(() => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });
  afterAll(() => vi.unstubAllGlobals());
  afterEach(cleanup);

  it("filters Validation Runs by the exact Guardrail ID", () => {
    const otherRun = { ...validationRun, id: "validation-banker-001", guardrail_id: "guardrail-banker", status: "failed" as const };
    const names = new Map([["guardrail-finance", "Finance Guardrail"], ["guardrail-banker", "Banker Guardrail"]]);

    expect(filterValidationRuns([validationRun, otherRun], names, "", "guardrail-banker", "all")).toEqual([otherRun]);
    expect(filterValidationRuns([validationRun, otherRun], names, "finance", "all", "passed")).toEqual([validationRun]);
  });

  it("keeps Validation history inside one Guardrail and opens records from the compact table", () => {
    const onOpen = vi.fn();
    const onRun = vi.fn();
    render(<GuardrailValidationHistory runs={[validationRun]} loading={false} error={null} canManage running={false} onRun={onRun} onOpen={onOpen} onOpenTarget={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Validation history" })).toBeTruthy();
    expect(screen.queryByText("Guardrail", { selector: "th" })).toBeNull();
    fireEvent.click(screen.getByText("validation-finance-001").closest("tr")!);
    expect(onOpen).toHaveBeenCalledWith(validationRun);
    fireEvent.click(screen.getByRole("button", { name: "Run Validation" }));
    expect(onRun).toHaveBeenCalledOnce();
  });

  it("opens the timestamped Target without opening the Validation Run", () => {
    const onOpen = vi.fn();
    const onOpenTarget = vi.fn();
    render(<GuardrailValidationHistory
      runs={[validationRun]}
      loading={false}
      error={null}
      canManage={false}
      running={false}
      onRun={vi.fn()}
      onOpen={onOpen}
      onOpenTarget={onOpenTarget}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Guardrail Version 20260904-010000.001Z" }));

    expect(onOpenTarget).toHaveBeenCalledWith(validationRun);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("shows the pinned contract and actual Rule match", () => {
    const { container } = render(<TestCaseResultRow result={result} />);

    expect(container.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("Policy scenario")).toBeTruthy();
    expect(screen.getByText("Acceptance provenance")).toBeTruthy();
    expect(screen.getByText("competitor-comparison-input-filter@1.95.0")).toBeTruthy();
    expect(screen.getByText("competitor-comparison-002")).toBeTruthy();
    expect(screen.getAllByText("competitor-comparison-intent")).toHaveLength(2);
  });

  it("only expands execution errors automatically", () => {
    const { container } = render(<TestCaseResultRow result={{ ...result, actual_failure: "provider_failure" }} />);

    expect(container.querySelector("details")?.hasAttribute("open")).toBe(true);
  });

  it("defaults a failed run to failed Cases and can reveal every result", () => {
    const passed = { ...result, case_id: "validation-case-2", name: "Passing case", passed: true };
    render(<ValidationCaseResults results={[result, passed]} defaultFilter="failed" />);

    expect(screen.getByText("Competitor comparison")).toBeTruthy();
    expect(screen.queryByText("Passing case")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /All/ }));

    expect(screen.getByText("Passing case")).toBeTruthy();
  });

  it("marks a failed Case and explains decision and Rule-contract mismatches", () => {
    render(<TestCaseResultRow result={{ ...result, expected_decision: "block", actual_decision: "transform", covered_rule_ids: ["credentials/aws_access_key"], matched_rule_ids: ["contact/br_phone_landline"] }} />);

    expect(screen.getByText("Competitor comparison").className).toContain("text-destructive");
    expect(screen.getByText("Why this Case failed")).toBeTruthy();
    expect(screen.getByText("Decision mismatch")).toBeTruthy();
    expect(screen.getByText("Rule contract mismatch")).toBeTruthy();
  });

  it("can exclude a failed inherited Case only from the current Guardrail", () => {
    const onValidationScopeChange = vi.fn();
    const { container } = render(<TestCaseResultRow result={result} onValidationScopeChange={onValidationScopeChange} />);
    fireEvent.click(container.querySelector("summary")!);
    fireEvent.click(screen.getByRole("button", { name: "guardrails.excludeTestCase" }));
    expect(onValidationScopeChange).toHaveBeenCalledWith(result.case_id, "exclude");
  });

  it("explains a Validation metric from its compact Tips icon", () => {
    render(<TooltipProvider><dl><DetailFact label="Pass rate" value="55.9%" definition="Cases whose actual result satisfied the expected decision." /></dl></TooltipProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Pass rate definition" }));

    expect(screen.getByRole("tooltip").textContent).toContain("Cases whose actual result satisfied the expected decision.");
  });
});
