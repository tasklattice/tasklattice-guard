import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import i18n from "@/i18n";
import { runtimeLogInteractions } from "@/lib/api";
import type { RuntimeEvent } from "@/lib/controller-api";
import { RuntimeCheckpoint } from "./runtime-log-sheet";

afterEach(cleanup);
const event: RuntimeEvent = { id: "event", requestId: "call-123", occurredAt: "2026-09-19T10:00:00Z", runnerId: "runner", guardrailId: "guard", guardrailVersion: "v1", endpointId: null, routerId: null, direction: "incoming", decision: "block", durationMs: 42, metadata: {} };
async function mount(overrides: Partial<RuntimeEvent>) {
  await i18n.changeLanguage("en");
  const entry = runtimeLogInteractions([{ ...event, ...overrides }], { includeUncaptured: true })[0]!.entries[0]!;
  return render(<RuntimeCheckpoint entry={entry} canViewContent />);
}
it("shows recorded error evidence immediately while leaving execution trace collapsed", async () => {
  await mount({ metadata: { executionStatus: "error", modelStatus: "unknown",
    diagnostics: [{ code: "AuthenticationError", stepId: "failed-span", source: "configuration", category: "authentication", httpStatus: 401, affectsResult: true }],
    trace: [{ id: "failed-span", name: "Judge action", outcome: "error", errorType: "AuthenticationError", providerName: "openai", modelName: "judge-model" }] } });
  expect(screen.getByText("AuthenticationError")).toBeTruthy();
  expect(screen.getByText("failed-span")).toBeTruthy();
  expect(screen.getByText("judge-model")).toBeTruthy();
  expect(screen.getByText("Execution failed")).toBeTruthy();
  expect(screen.getByText("401")).toBeTruthy();
  expect(screen.getByText("Recorded action: Block")).toBeTruthy();
  expect(screen.queryByText("Block", { exact: true })).toBeNull();
  expect(screen.getByRole("button", { name: /Execution trace/ }).getAttribute("aria-expanded")).toBe("false");
});
it("explains inferred completion without inventing an exception or request body", async () => {
  await mount({ id:"call:decision", direction:"completion", decision:"timeout", durationMs:300000, metadata:{ executionStatus:"timeout",logKind:"call_completion",completionInferred:true,decisionId:"decision",completedAt:"2026-09-19T10:05:00Z" } });
  expect(screen.getByText("Completion not reported · inferred timeout")).toBeTruthy();
  expect(screen.getByText(/within 300 seconds/).textContent).toContain("does not confirm a model error");
  expect(screen.getByText("decision")).toBeTruthy();
  expect(screen.queryByText("Request content")).toBeNull();
  expect(screen.queryByRole("button", { name:/Execution trace/ })).toBeNull();
});
it("renders a reported failure reason as text", async () => {
  await mount({ direction:"completion",decision:"error",metadata:{executionStatus:"error",logKind:"call_completion",failureReason:"upstream_unavailable"} });
  expect(screen.getByText("upstream_unavailable")).toBeTruthy();
  expect(screen.queryByText(/does not confirm a model error/)).toBeNull();
});

it("explains failure handling without presenting a policy Block badge", async () => {
  await mount({ metadata: { executionStatus: "error", terminationReason: "fail_closed", modelStatus: "error",
    diagnostics: [{ code: "HTTPStatusError", category: "rate_limit", source: "model", affectsResult: true,
      stepId: "model-call", modelCallId: "rpc-429", httpStatus: 429, message: "Provider quota exceeded." }],
    trace: [{ id: "model-call", kind: "evaluator", modelCallId: "rpc-429", modelResult: "rate_limited", providerName: "NIM", modelName: "safety" }] } });
  expect(screen.getByText(/failure policy blocked the request/)).toBeTruthy();
  expect(screen.getByText(/Check Provider quota and concurrency limits/)).toBeTruthy();
  expect(screen.getByText("rpc-429")).toBeTruthy();
  expect(screen.getByText("rate_limited")).toBeTruthy();
  expect(screen.getByText(/Provider quota exceeded/)).toBeTruthy();
  expect(screen.queryByText("Block", { exact: true })).toBeNull();
});

it("keeps skipped checks collapsed and does not diagnose legacy unknowns as missing configuration", async () => {
  await mount({ metadata: { executionStatus: "error", modelStatus: "ok", diagnostics: [
    { code: "uncovered", category: "uncovered", stepId: "skipped-local-check", affectsResult: true },
    { code: "needs_context", category: "needs_context", source: "configuration", stepId: "safety", affectsResult: true,
      message: "A required check is missing context." },
  ] } });
  expect(screen.getByText(/No specific missing request field was identified/)).toBeTruthy();
  expect(screen.queryByText(/Integration configuration error/)).toBeNull();
  expect(screen.queryByText("A required check is missing context.")).toBeNull();
  const toggle = screen.getByText("Checks not executed (1)");
  expect(toggle.closest("details")?.open).toBe(false);
  toggle.click();
  expect(toggle.closest("details")?.open).toBe(true);
  expect(screen.getByText("skipped-local-check")).toBeTruthy();
});

it("distinguishes a successful but uncertain model response from a call failure", async () => {
  await mount({ metadata: { executionStatus: "error", modelStatus: "ok", diagnostics: [
    { code: "model_uncertain", category: "model_uncertain", source: "model", stepId: "classification", affectsResult: true },
  ] } });
  expect(screen.getByText("Model calls: OK")).toBeTruthy();
  expect(screen.getByText(/Model classification ·/)).toBeTruthy();
  expect(screen.getByText(/responded successfully but could not make a conclusive classification/)).toBeTruthy();
  expect(screen.queryByText(/Model service \/ response error/)).toBeNull();
});

it("does not invent Block or a model failure for a completion-only error", async () => {
  await mount({ direction: "completion", decision: "error", metadata: { executionStatus: "error", logKind: "call_completion" } });
  expect(screen.getByText("No action recorded")).toBeTruthy();
  expect(screen.getByText(/does not establish whether the request was blocked or allowed/)).toBeTruthy();
  expect(screen.getByText(/No exception details were retained/)).toBeTruthy();
  expect(screen.queryByText("Recorded action: Block")).toBeNull();
});

it("does not turn recovered diagnostics into an execution failure", async () => {
  await mount({ metadata: { executionStatus: "complete", diagnostics: [
    { code: "HTTPStatusError", category: "unavailable", stepId: "recovered", affectsResult: false },
  ] } });
  expect(screen.getByText("Block", { exact: true })).toBeTruthy();
  expect(screen.queryByText("Execution failed")).toBeNull();
  expect(screen.getByText(/did not invalidate the final result/)).toBeTruthy();
});
