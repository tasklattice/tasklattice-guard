import type { RuntimeLogDiagnostic } from "./api-types";
import { enumValue, numberValue, stringValue } from "./controller-api-mappers";

/** Join only recorded identities; never attribute an unrelated model's failure. */
export function runtimeLogDiagnostics(diagnostics: Record<string, unknown>[], trace: Record<string, unknown>[]): RuntimeLogDiagnostic[] {
  const byId = new Map(trace.map(step => [stringValue(step.id), step]));
  const isDescendant = (child: Record<string, unknown>, parent: Record<string, unknown>) => {
    const visited = new Set<unknown>();
    for (let id = child.parentId; typeof id === "string" && !visited.has(id); id = byId.get(id)?.parentId) {
      if (id === parent.id) return true;
      visited.add(id);
    }
    return false;
  };
  const records = diagnostics.map(d => {
    const id = stringValue(d.stepId);
    let step = id ? byId.get(id) : undefined;
    // Older module diagnostics used a module ID as the Span ID. Associate it
    // only when exactly one inconclusive action in that module was retained.
    if (!step && d.code === "needs_context") {
      const candidates = trace.filter(s => s.moduleId === id && s.kind === "action" && s.verdict === "unknown");
      if (candidates.length === 1) step = candidates[0];
    }
    const callId = stringValue(d.modelCallId) ?? stringValue(step?.modelCallId);
    const calls = trace.filter(s => s.kind === "evaluator" && s.modelResult &&
      (callId ? s.modelCallId === callId : step && (s.id === step.id || isDescendant(s, step)
        || typeof step.parentId === "string" && s.parentId === step.parentId && step.kind === "evaluation")));
    const call = calls.length === 1 ? calls[0] : undefined;
    // Historical needs_context was also used for valid but uncertain model
    // responses. Without explicit field-level evidence, its source is unknown.
    const legacyUnknown = d.code === "needs_context" && (!d.category || d.category === "needs_context");
    return {
      source: legacyUnknown ? "unknown" as const : enumValue(d.source ?? step?.errorSource ?? call?.errorSource, ["model", "configuration", "guard", "unknown", "mixed"] as const),
      category: legacyUnknown ? "inconclusive" : stringValue(d.category) ?? stringValue(step?.errorCategory) ?? stringValue(call?.errorCategory) ?? (d.code === "uncovered" ? "uncovered" : "unknown"),
      http_status: numberValue(d.httpStatus) ?? numberValue(call?.httpStatus) ?? numberValue(step?.httpStatus),
      model_call_id: callId ?? stringValue(call?.modelCallId), model_result: stringValue(call?.modelResult) ?? stringValue(step?.modelResult),
      affects_result: d.affectsResult === true,
      span_id: stringValue(step?.id) ?? id ?? "—", related_spans: id ? [id] : [],
      name: stringValue(step?.actionName) ?? stringValue(call?.actionName) ?? stringValue(step?.name) ?? id ?? "Guardrail",
      message: legacyUnknown ? null : stringValue(d.message),
      error_type: stringValue(d.code), provider: stringValue(call?.providerName) ?? stringValue(step?.providerName),
      model: stringValue(call?.modelName) ?? stringValue(step?.modelName), policy: stringValue(d.policyId) ?? stringValue(call?.policyId) ?? stringValue(step?.policyId),
      timed_out: d.code === "timeout" || call?.timedOut === true, timeout_ms: numberValue(step?.timeoutMs) ?? numberValue(call?.timeoutMs),
    } satisfies RuntimeLogDiagnostic;
  });
  const grouped = new Map<string, RuntimeLogDiagnostic>();
  for (const [index, record] of records.entries()) {
    // Parent Rail/Action diagnostics can describe the same failed RPC. Retain
    // all correlation IDs but display that cause once. Independent calls stay separate.
    const identity = record.model_call_id ?? (record.span_id !== "—" ? record.span_id : `unidentified:${index}`);
    const key = JSON.stringify([identity, record.source, record.category, record.affects_result]);
    const previous = grouped.get(key);
    if (previous) {
      previous.related_spans = [...new Set([...(previous.related_spans ?? []), record.span_id, ...(record.related_spans ?? [])])];
      if ((!previous.error_type || previous.error_type === "check_failed") && record.error_type) previous.error_type = record.error_type;
    } else grouped.set(key, record);
  }
  return [...grouped.values()].sort((a, b) => Number(b.affects_result) - Number(a.affects_result));
}
