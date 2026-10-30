import * as api from "@/lib/api";
import { act, cleanup, fireEvent, render as testingRender, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { TestCaseResult, ValidationRun } from "@/lib/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/features/query-keys";

import { DetailFact, filterValidationRuns, GuardrailValidationHistory, TestCaseResultRow, ValidationCaseResults, ValidationDetailSheet } from "./validation";

function render(ui: React.ReactNode) {
  return testingRender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
}
vi.mock("@/components/add-test-case-sheet", () => ({ AddTestCaseSheet: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { id?: string }) => key === "validation.validationRunNamed" ? `Testing Report ${options?.id}` : ({
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
      "validation.validationContractMismatch": "Test expectations mismatch",
      "validation.validationRunColumn": "Testing Report",
      "validation.targetColumn": "Target",
      "validation.casesColumn": "Cases",
      "validation.statusColumn": "Status",
      "validation.passRateColumn": "Pass rate",
      "validation.durationColumn": "Duration",
      "validation.runAtColumn": "Run at",
      "validation.openValidationRun": "Open Testing Report",
      "guardrails.validationHistoryTitle": "Testing Reports",
      "guardrails.validationHistoryDescription": "Immutable release-gate evidence.",
      "guardrails.runReviewed": "Run tests",
      "validation.versionTarget": "Guardrail Version 20260904-010000.001Z",
      "guardrails.expectedDecision": "Expected decision",
      "guardrails.actualDecision": "Actual decision",
    } as Record<string, string>)[key] ?? key,
    i18n: { language: "en", exists: () => false },
  }),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "user" } }) }));

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
  action: "block",
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
  superseded_by: [],
  evidence_status: "observed", evidence_detail: "Observed target Rule",
  verified_rule_ids: [], rule_contract_satisfied: true,
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

function mockCases(rows:TestCaseResult[]) {
  const counts={all:rows.length,passed:rows.filter(r=>r.passed&&!r.skipped).length,failed:rows.filter(r=>!r.passed&&!r.skipped).length,skipped:rows.filter(r=>r.skipped).length,warnings:rows.filter(r=>r.passed&&r.actual_failure&&!r.expected_failure).length};
  vi.spyOn(api,"getValidationCases").mockImplementation(async(_id,filter)=>({items:rows.map((r,ordinal)=>({...r,ordinal})).filter(r=>filter==="all"||(filter==="skipped"?r.skipped:!r.skipped&&(filter==="passed"?r.passed:!r.passed))),count:counts[filter],counts,nextCursor:null}));
  vi.spyOn(api,"getValidationCase").mockImplementation(async(_id,ordinal)=>({result:rows[ordinal]!,traceCount:0,nextTraceOffset:null}));
}

describe("Testing Report acceptance evidence", () => {
  beforeAll(() => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });
  afterAll(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.spyOn(api, "getValidationCases").mockResolvedValue({ items: [{ ...result, ordinal: 0 }], count: 1, counts: { all: 1, passed: 0, failed: 1, skipped: 0, warnings: 0 }, nextCursor: null });
    vi.spyOn(api, "getValidationCase").mockResolvedValue({ result, nextTraceOffset: null, traceCount: 0 });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("loads case results only when a summary is opened", async () => {
    const getDetail = vi.spyOn(api, "getValidationRun").mockResolvedValue({ ...validationRun, details_loaded: true, results: [result] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const props = { canManage: false, running: false, onRunAgain: vi.fn(), onClose: vi.fn() };
    const view = render(<QueryClientProvider client={client}><TooltipProvider><ValidationDetailSheet {...props} run={null} /></TooltipProvider></QueryClientProvider>);
    expect(getDetail).not.toHaveBeenCalled();
    view.rerender(<QueryClientProvider client={client}><TooltipProvider><ValidationDetailSheet {...props} run={{ ...validationRun, details_loaded: false }} /></TooltipProvider></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText(result.name)).toBeTruthy());
    expect(getDetail).toHaveBeenCalledExactlyOnceWith(validationRun.id);
    view.unmount();
    client.clear();
    getDetail.mockRestore();
  });

  it("fetches a single case only after expansion and resets pagination when its filter changes", async () => {
    const cases = vi.mocked(api.getValidationCases).mockResolvedValue({ items: [{ ...result, ordinal: 7 }], count: 80,
      counts: { all: 80, failed: 1, passed: 79, skipped: 0, warnings: 0 }, nextCursor: "page-two" });
    const detail = vi.mocked(api.getValidationCase);
    render(<ValidationCaseResults runId="bounded" results={[]} />);
    expect(await screen.findByText(result.name)).toBeTruthy();
    expect(detail).not.toHaveBeenCalled();
    const row = screen.getByText(result.name).closest("details")!;
    row.open = true;
    fireEvent(row, new Event("toggle", { bubbles: true }));
    await waitFor(() => expect(detail).toHaveBeenCalledExactlyOnceWith("bounded", 7, 0, expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole("button", { name: "common.next" }));
    await waitFor(() => expect(cases).toHaveBeenLastCalledWith("bounded", "all", "page-two", expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole("button", { name: /Failed/ }));
    await waitFor(() => expect(cases).toHaveBeenLastCalledWith("bounded", "failed", undefined, expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole("button", { name: /All/ }));
    await waitFor(() => expect(cases).toHaveBeenLastCalledWith("bounded", "all", undefined, expect.any(AbortSignal)));
  });

  it("keeps a failed case detail retry local without reloading every report result", async () => {
    const detail = vi.mocked(api.getValidationCase).mockRejectedValueOnce(new Error("Case temporarily unavailable")).mockResolvedValueOnce({ result, nextTraceOffset: null, traceCount: 0 });
    render(<ValidationCaseResults runId="bounded" results={[]} />);
    const row = (await screen.findByText(result.name)).closest("details")!;
    row.open = true; fireEvent(row, new Event("toggle", { bubbles: true }));
    expect(await screen.findByText("Case temporarily unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    await waitFor(() => expect(detail).toHaveBeenCalledTimes(2));
    expect(api.getValidationCases).toHaveBeenCalledTimes(1);
  });

  it.each(["validation", "testing-report"])("shows a Testing Report number for %s IDs and opens the original record", (prefix) => {
    const number = "54b2887b-c498-4e1d-be84-01105d2e6413";
    const run = { ...validationRun, id: `${prefix}-${number}` };
    const onOpen = vi.fn();
    render(<GuardrailValidationHistory runs={[run]} loading={false} error={null} canManage={false} running={false} onRun={vi.fn()} onOpen={onOpen} onOpenTarget={vi.fn()} />);
    expect(screen.getByText("Testing Report 54B2887B")).toBeTruthy();
    expect(screen.queryByText(run.id)).toBeNull();
    fireEvent.click(screen.getByText(number));
    expect(onOpen).toHaveBeenCalledWith(run);
  });

  it("blocks running from history while dependency repair is required", () => {
    const onRun = vi.fn();
    render(<GuardrailValidationHistory runs={[validationRun]} loading={false} error={null} canManage running={false} blockedReason="Remove Topic Control first" onRun={onRun} onOpen={vi.fn()} onOpenTarget={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Run tests" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("shows the recorded execution failure and disables rerun for current dependency blockers", () => {
    const onRunAgain = vi.fn();
    render(<QueryClientProvider client={new QueryClient()}><TooltipProvider><ValidationDetailSheet run={{ ...validationRun, status: "failed", failure_reason: "Topic model assignment is missing", results: [] }} canManage running={false} blockedReason="Remove Topic Control first" onRunAgain={onRunAgain} onClose={vi.fn()} /></TooltipProvider></QueryClientProvider>);
    expect(screen.getByText("Topic model assignment is missing")).toBeTruthy();
    expect(screen.getByText("Remove Topic Control first")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "validation.runAgain" }));
    expect(onRunAgain).not.toHaveBeenCalled();
  });

  it("filters Testing Reports by the exact Guardrail ID", () => {
    const otherRun = { ...validationRun, id: "validation-banker-001", guardrail_id: "guardrail-banker", status: "failed" as const };
    const names = new Map([["guardrail-finance", "Finance Guardrail"], ["guardrail-banker", "Banker Guardrail"]]);

    expect(filterValidationRuns([validationRun, otherRun], names, "", "guardrail-banker", "all")).toEqual([otherRun]);
    expect(filterValidationRuns([validationRun, otherRun], names, "finance", "all", "passed")).toEqual([validationRun]);
  });

  it("shows version test progress without draft wording or premature report actions", () => {
    const getDetail = vi.spyOn(api, "getValidationRun").mockImplementation(() => new Promise(() => {}));
    const run = { ...validationRun, subject: "version", execution_status: "queued", status: "incomplete" } as ValidationRun;
    const client = new QueryClient();
    const view = render(<QueryClientProvider client={client}><TooltipProvider><ValidationDetailSheet run={run} canManage={false} running={false} onRunAgain={vi.fn()} onRunVersionAgain={vi.fn()} onClose={vi.fn()} /></TooltipProvider></QueryClientProvider>);
    expect(screen.getByRole("region", { name: "guardrails.testProgress.title" })).toBeTruthy();
    expect(screen.getByText("validation.processingHint")).toBeTruthy();
    expect(screen.queryByText("guardrails.testingInPlace")).toBeNull();
    expect(screen.queryByRole("button", { name: "validation.runAgain" })).toBeNull();
    view.unmount();
    client.clear();
    getDetail.mockRestore();
  });

  it.each(["queued", "preparing", "executing", "finalizing"] as const)("keeps Reporter content hidden during %s, even if provisional results exist", phase => {
    const getDetail = vi.spyOn(api, "getValidationRun").mockImplementation(() => new Promise(() => {}));
    const run = { ...validationRun, subject: "version", execution_status: phase === "queued" ? "queued" : "running",
      progress: phase === "queued" ? null : { phase, completedCases: 1, passedCases: 1, updatedAt: new Date().toISOString() },
      results: [result] } as ValidationRun;
    const client = new QueryClient();
    const onClose = vi.fn();
    const view = render(<QueryClientProvider client={client}><TooltipProvider><ValidationDetailSheet run={run} canManage running={false} onRunAgain={vi.fn()} onClose={onClose} /></TooltipProvider></QueryClientProvider>);
    expect(screen.getByRole("region", { name: "guardrails.testProgress.title" })).toBeTruthy();
    expect(screen.getByText("Target")).toBeTruthy();
    expect(screen.queryByText("Pass rate")).toBeNull();
    expect(screen.queryByText("validation.reportScopeHelp")).toBeNull();
    expect(screen.queryByText("Case results")).toBeNull();
    expect(screen.queryByText(result.name)).toBeNull();
    expect(screen.queryByRole("button", { name: "validation.deleteReport" })).toBeNull();
    expect(screen.queryByRole("button", { name: "validation.runAgain" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "validation.closeWhileRunning" }));
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    client.clear();
    getDetail.mockRestore();
  });

  it.each(["passed", "failed"] as const)("switches the same run to the final report only after execution is %s", async status => {
    const current = { ...validationRun, status: "incomplete", execution_status: "running", details_loaded: true,
      progress: { phase: "finalizing", completedCases: 1, passedCases: 1, updatedAt: new Date().toISOString() } } as ValidationRun;
    const getDetail = vi.spyOn(api, "getValidationRun").mockResolvedValue(current);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><TooltipProvider><ValidationDetailSheet run={current} canManage running={false} onRunAgain={vi.fn()} onClose={vi.fn()} /></TooltipProvider></QueryClientProvider>);
    await waitFor(() => expect(client.getQueryData(queryKeys.validationRun(current.id))).toBeTruthy());
    expect(screen.queryByText("validation.reportScopeHelp")).toBeNull();
    act(() => client.setQueryData(queryKeys.validationRun(current.id), { ...current, execution_status: status, status, results: [result] }));
    expect(await screen.findByText(result.name)).toBeTruthy();
    expect(screen.getByText("Pass rate")).toBeTruthy();
    expect(screen.getByText("validation.reportScopeHelp")).toBeTruthy();
    expect(screen.getByRole("button", { name: "validation.runAgain" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "guardrails.testProgress.title" })).toBeNull();
    expect(screen.queryByText("validation.processingHint")).toBeNull();
    view.unmount();
    client.clear();
    getDetail.mockRestore();
  });

  it("shows cancellation without presenting partial results as a final report", () => {
    const client = new QueryClient();
    const view = render(<QueryClientProvider client={client}><TooltipProvider><ValidationDetailSheet
      run={{ ...validationRun, status: "cancelled", execution_status: "cancelled", results: [result] }} canManage running={false} onRunAgain={vi.fn()} onClose={vi.fn()}
    /></TooltipProvider></QueryClientProvider>);
    expect(screen.getByText("validation.cancelledWithoutReport")).toBeTruthy();
    expect(screen.queryByText("Pass rate")).toBeNull();
    expect(screen.queryByText(result.name)).toBeNull();
    expect(screen.queryByText("validation.reportScopeHelp")).toBeNull();
    expect(screen.getByRole("button", { name: "validation.runAgain" })).toBeTruthy();
    view.unmount();
    client.clear();
  });

  it("does not replace a missing failed report with zero metrics and empty result filters", () => {
    const client = new QueryClient();
    const view = render(<QueryClientProvider client={client}><TooltipProvider><ValidationDetailSheet
      run={{ ...validationRun, status: "failed", execution_status: "failed", failure_reason: "Runner connection failed", metrics:{...validationRun.metrics,total:0} }} canManage running={false} onRunAgain={vi.fn()} onClose={vi.fn()}
    /></TooltipProvider></QueryClientProvider>);
    expect(screen.getByText("Runner connection failed")).toBeTruthy();
    expect(screen.getByText("validation.noReportResults")).toBeTruthy();
    expect(screen.queryByText("Pass rate")).toBeNull();
    expect(screen.queryByRole("group", { name: "Filter Case results" })).toBeNull();
    view.unmount();
    client.clear();
  });

  it("keeps Testing Reports inside one Guardrail and opens records from the compact table", () => {
    const onOpen = vi.fn();
    const onRun = vi.fn();
    render(<GuardrailValidationHistory runs={[validationRun]} loading={false} error={null} canManage running={false} onRun={onRun} onOpen={onOpen} onOpenTarget={vi.fn()} />);

    expect(screen.getByRole("region", { name: "Testing Reports" })).toBeTruthy();
    expect(screen.queryByText("Guardrail", { selector: "th" })).toBeNull();
    fireEvent.click(screen.getByText("finance-001").closest("tr")!);
    expect(onOpen).toHaveBeenCalledWith(validationRun);
    fireEvent.click(screen.getByRole("button", { name: "Run tests" }));
    expect(onRun).toHaveBeenCalledOnce();
  });

  it("opens the timestamped Target without opening the Testing Report", () => {
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

  it("explains superseding interventions without treating them as Rule acceptance", () => {
    render(<TestCaseResultRow result={{ ...result, passed: false, expected_decision: "block", actual_decision: "block", matched_rule_ids: [],
      evidence_status: "preempted_by", evidence_detail: "Target Rule was not reached", rule_contract_satisfied: false,
      superseded_by: [{ policyId: "earlier-toxic-policy", ruleId: "toxic-rule" }] }} />);
    fireEvent.click(document.querySelector("summary")!);
    expect(screen.getByText("validation.supersededTitle")).toBeTruthy();
    expect(screen.getByText("earlier-toxic-policy / toxic-rule")).toBeTruthy();
    expect(screen.getByText("Target Rule was not reached")).toBeTruthy();
    expect(screen.getByText("Rule contract mismatch")).toBeTruthy();
  });

  it("uses the recorded evidence contract instead of inferring success from partial matches", () => {
    render(<TestCaseResultRow result={{ ...result, passed: false,
      covered_rule_ids: [...result.covered_rule_ids, "missing-rule"],
      evidence_status: "missing", rule_contract_satisfied: false }} />);
    fireEvent.click(document.querySelector("summary")!);
    expect(screen.getByText("Rule contract mismatch")).toBeTruthy();
  });

  it("does not report a Rule mismatch when a reviewed composition contract was satisfied", () => {
    render(<TestCaseResultRow result={{ ...result, passed: false, expected_decision: "transform", actual_decision: "block",
      matched_rule_ids: [], evidence_status: "shadowed_by", rule_contract_satisfied: true }} />);
    fireEvent.click(document.querySelector("summary")!);
    expect(screen.getByText("Decision mismatch")).toBeTruthy();
    expect(screen.queryByText("Rule contract mismatch")).toBeNull();
  });

  it("shows the pinned contract and actual Rule match", () => {
    const { container } = render(<TestCaseResultRow result={result} />);

    expect(container.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("Policy scenario")).toBeTruthy();
    expect(screen.getByText("Acceptance provenance")).toBeTruthy();
    expect(screen.getByText("competitor-comparison-input-filter@1.95.0")).toBeTruthy();
    expect(screen.getByText("competitor-comparison-002")).toBeTruthy();
    expect(screen.getByText("validation.expectedAndMatchedRules")).toBeTruthy();
    expect(screen.getAllByText("competitor-comparison-intent")).toHaveLength(1);
  });

  it("only expands execution errors automatically", () => {
    const { container } = render(<TestCaseResultRow result={{ ...result, actual_failure: "provider_failure" }} />);

    expect(container.querySelector("details")?.hasAttribute("open")).toBe(true);
  });

  it("keeps successful Rule acceptance visible with a separate execution warning", async () => {
    const warning = { ...result, passed: true, case_type: "rule_acceptance", actual_failure: "provider_failure", rule_contract_satisfied: true };
    const { container } = (mockCases([warning]), render(<ValidationCaseResults runId="warning" defaultFilter="passed" />));
    await screen.findByText(warning.name);
    const row=container.querySelector("details")!;
    expect(row.open).toBe(false);row.open=true;fireEvent(row,new Event("toggle",{bubbles:true}));
    expect(await screen.findByText("validation.executionWarningTitle")).toBeTruthy();
    expect(screen.getByText("validation.executionWarningBadge")).toBeTruthy();
    expect(screen.getByText("validation.executionWarningCount")).toBeTruthy();
    expect(screen.queryByText("Why this Case failed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Failed/ }));
    await waitFor(()=>expect(screen.queryByText(warning.name)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Passed/ }));
    expect(await screen.findByText(warning.name)).toBeTruthy();
  });

  it("does not label an explicitly expected infrastructure failure as an unrelated warning", () => {
    render(<TestCaseResultRow result={{ ...result, passed: true, expected_failure: "timeout", actual_failure: "timeout" }} />);
    expect(screen.queryByText("validation.executionWarningTitle")).toBeNull();
  });

  it("defaults a failed run to failed Cases and can reveal every result", async () => {
    const passed = { ...result, case_id: "validation-case-2", name: "Passing case", passed: true };
    mockCases([result,passed]);
    render(<ValidationCaseResults runId="mixed" defaultFilter="failed" />);

    expect(await screen.findByText("Competitor comparison")).toBeTruthy();
    expect(screen.queryByText("Passing case")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /All/ }));

    expect(await screen.findByText("Passing case")).toBeTruthy();
  });

  it("explains an empty result filter and lets reviewers return to all Cases", async () => {
    mockCases([{...result,passed:true}]);
    render(<ValidationCaseResults runId="empty-filter" />);
    await screen.findByText(result.name);
    fireEvent.click(screen.getByRole("button", { name: /Failed/ }));
    expect((await screen.findByRole("status")).textContent).toBe("validation.emptyCaseResults.failed");
    expect(screen.queryByText(result.name)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /All/ }));
    expect(await screen.findByText(result.name)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("recovers a failed detail load through retry", async () => {
    const getDetail = vi.spyOn(api, "getValidationRun").mockRejectedValueOnce(new Error("Report temporarily unavailable"))
      .mockResolvedValueOnce({ ...validationRun, details_loaded: true, results: [result] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><TooltipProvider><ValidationDetailSheet
      run={{ ...validationRun, details_loaded: false }} canManage={false} running={false} onRunAgain={vi.fn()} onClose={vi.fn()}
    /></TooltipProvider></QueryClientProvider>);
    expect(await screen.findByText("Report temporarily unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(await screen.findByText(result.name)).toBeTruthy();
    expect(getDetail).toHaveBeenCalledTimes(2);
    view.unmount();
    client.clear();
    getDetail.mockRestore();
  });

  it("marks a failed Case and explains decision and Rule-contract mismatches", () => {
    render(<TestCaseResultRow result={{ ...result, expected_decision: "block", actual_decision: "transform", covered_rule_ids: ["credentials/aws_access_key"], matched_rule_ids: ["contact/br_phone_landline"], rule_contract_satisfied: false }} />);

    expect(screen.getByText(/^failed$/i)).toBeTruthy();
    expect(screen.getByText("Why this Case failed")).toBeTruthy();
    expect(screen.getByText("Decision mismatch")).toBeTruthy();
    expect(screen.getByText("Rule contract mismatch")).toBeTruthy();
    expect(screen.queryByText("Expected decision")).toBeNull();
    expect(screen.queryByText("Actual decision")).toBeNull();
    expect(screen.queryByText("Contract Rules")).toBeNull();
    expect(screen.queryByText("Actually matched Rules")).toBeNull();
    expect(screen.queryByText(result.reason)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /logs.executionTrace/ }));
    expect(screen.getByText(result.reason)).toBeTruthy();
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


describe("Explicit skipped model evidence", () => {
  it("keeps skipped cases out of failed and passed filters", async () => {
    const skipped = { ...result, case_id: "skipped", name: "Model safety", skipped: true, skip_reason: "Model-dependent tests skipped", passed: false, actual_decision: "", trace: [] };
    mockCases([{...result,name:"Local failure"},skipped]);
    render(<ValidationCaseResults runId="skipped" />);
    await screen.findByText("Local failure");
    fireEvent.click(screen.getByRole("button", { name: /Failed\s*1/ }));
    await waitFor(()=>expect(screen.queryByText("Model safety")).toBeNull());
    expect(await screen.findByText("Local failure")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /validationScope.skipped\s*1/ }));
    expect(await screen.findByText("Model safety")).toBeTruthy();
    expect(screen.queryByText("Why this Case failed")).toBeNull();
  });
});
