import { expect, it } from "vitest";
import { traceDiagnostics } from "./execution-trace-errors";
import type { ExecutionTraceStep } from "./execution-trace";

const step: ExecutionTraceStep = { id: "provider", kind: "evaluator", name: "Judge", outcome: "server_error", latency_ms: 5,
  error_source: "model", error_category: "unavailable", error_type: "http_503", http_status: 503,
  model_call_id: "call-1", model_name: "judge-v1", provider_name: "provider-1", affects_result: true };

it("uses structured model provenance even without descriptive text", () => {
  expect(traceDiagnostics([step])).toEqual([{ source: "model", category: "unavailable", httpStatus: 503,
    modelCallId: "call-1", model: "judge-v1", provider: "provider-1", affectsResult: true,
    sources: ["Judge"], spanIds: ["provider"], details: ["http_503"] }]);
});
it("does not use model words or HTTP codes in descriptions to assign responsibility", () => {
  const rows = traceDiagnostics([{ id: "guard", kind: "action", name: "Model processing", outcome: "error", latency_ms: 1,
    error_source: "guard", error_category: "internal", detail: "Expected HTTP 503; got a different classification." }]);
  expect(rows[0]).toMatchObject({ source: "guard", category: "internal", httpStatus: undefined });
});
it("keeps unrecorded provenance unknown", () => {
  expect(traceDiagnostics([{ id: "unrecorded", kind: "action", name: "Safety Provider", outcome: "error", latency_ms: 0,
    detail: "HTTPStatusError 401" }])[0]).toMatchObject({ source: "unknown", category: "unknown", httpStatus: undefined });
});
it("merges causal parent summaries by call ID without merging separate provider attempts", () => {
  const rows = traceDiagnostics([step, { ...step, id: "action", name: "Action" }, { ...step, id: "retry", model_call_id: "call-2" }]);
  expect(rows).toHaveLength(2);
  expect(rows[0].spanIds).toEqual(["provider", "action"]);
});
it("retains recovered model faults without marking the request as failed", () => {
  expect(traceDiagnostics([{ ...step, affects_result: false }])[0].affectsResult).toBe(false);
});
it.each(["complete", "cancelled", "block", "matched", "not_matched"])("does not treat %s as a model error", outcome => {
  expect(traceDiagnostics([{ id: "ok", kind: "evaluator", name: "Judge", outcome, latency_ms: 1, model_result: "success" }])).toEqual([]);
});
