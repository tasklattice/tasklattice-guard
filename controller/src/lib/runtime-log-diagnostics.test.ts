import { expect, it } from "vitest";
import { runtimeLogDiagnostics } from "./runtime-log-diagnostics";

const call = { id: "rpc-span", kind: "evaluator", parentId: "action", modelCallId: "rpc-id", modelResult: "client_error",
  providerName: "provider", modelName: "judge", httpStatus: 401 };
const diagnostic = { stepId: "action", code: "HTTPStatusError", category: "authentication", source: "configuration", modelCallId: "rpc-id", affectsResult: true, message: "Credentials rejected." };

it("joins model call facts and retains the diagnostic message, deduplicating ancestors", () => {
  const result = runtimeLogDiagnostics([diagnostic, { ...diagnostic, stepId: "rpc-span" }], [
    { id: "action", kind: "action", actionName: "Check safety", policyId: "safety" }, call,
  ]);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ message: "Credentials rejected.", name: "Check safety", model_result: "client_error",
    provider: "provider", model: "judge", http_status: 401, model_call_id: "rpc-id", related_spans: ["action", "rpc-span"] });
});

it("keeps separate failures and recovered calls separate", () => {
  const result = runtimeLogDiagnostics([diagnostic, { ...diagnostic, stepId: "second", modelCallId: "other" },
    { ...diagnostic, affectsResult: false }], [call, { ...call, id: "second", modelCallId: "other" }]);
  expect(result).toHaveLength(3);
  expect(result.map(item => item.affects_result)).toEqual([true, true, false]);
});

it("links a module-level unknown only to an unambiguous action and its model call", () => {
  const result = runtimeLogDiagnostics([{ code: "needs_context", stepId: "safety", source: "configuration" }], [
    { id: "action", kind: "action", moduleId: "safety", verdict: "unknown" }, { ...call, modelResult: "success", httpStatus: undefined },
  ]);
  expect(result[0]).toMatchObject({ category: "inconclusive", source: "unknown", model: "judge", model_result: "success" });
  const ambiguous = runtimeLogDiagnostics([{ code: "needs_context", stepId: "safety" }], [
    { id: "action", kind: "action", moduleId: "safety", verdict: "unknown" },
    { id: "other-block", kind: "action", moduleId: "safety", verdict: "unknown" }, call,
  ]);
  expect(ambiguous[0].model).toBeNull();
});

it("does not attribute another parallel model call or an unrelated trace to a diagnostic", () => {
  const result = runtimeLogDiagnostics([{ code: "inconclusive", stepId: "unknown", affectsResult: true }], [
    { id: "unknown", kind: "evaluation", parentId: "action" }, call,
    { ...call, id: "parallel", modelCallId: "other" },
  ]);
  expect(result[0].model_call_id).toBeNull();
  expect(result[0].http_status).toBeNull();
});

it("retains explicit missing-field diagnostics and tolerates broken/cyclic parents", () => {
  expect(runtimeLogDiagnostics([{ code: "missing_query", category: "missing_query", source: "configuration", stepId: "context" }], [
    { id: "context", kind: "evaluation" }, { ...call, parentId: "cycle" }, { id: "cycle", parentId: "rpc-span" },
  ])[0]).toMatchObject({ source: "configuration", category: "missing_query", model: null });
});

it("keeps unidentified diagnostics separate and preserves an HTTP status on the owning span", () => {
  expect(runtimeLogDiagnostics([{ code: "check_failed" }, { code: "check_failed" }], [])).toHaveLength(2);
  expect(runtimeLogDiagnostics([{ code: "check_failed", stepId: "action" }], [
    { id: "action", kind: "action", httpStatus: 403 },
  ])[0].http_status).toBe(403);
});
