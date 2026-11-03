import type { ExecutionTraceStep } from "./execution-trace";
import type { ErrorSource } from "../../shared/execution-diagnostics";

export function isFailedTraceStep(step: ExecutionTraceStep): boolean {
  return /^(error|failed|failure|timeout|timed_out|rate_limited|server_error|client_error|transport_error|invalid_response|unknown_error)$/i.test(step.outcome)
    || Boolean(step.error_source) && !isModelClassificationDiagnostic(step.error_category);
}

export function isModelClassificationDiagnostic(category?: string | null): boolean {
  return ["model_uncertain", "category_mapping", "review_inconclusive"].includes(category ?? "");
}

export type TraceDiagnostic = {
  source: ErrorSource;
  category: string;
  httpStatus?: number;
  modelCallId?: string;
  provider?: string;
  model?: string;
  affectsResult: boolean;
  sources: string[];
  spanIds: string[];
  details: string[];
};

/** Display recorded provenance. Assertion text never establishes fault ownership. */
export function traceDiagnostics(steps: ExecutionTraceStep[]): TraceDiagnostic[] {
  const groups = new Map<string, TraceDiagnostic>();
  for (const step of steps) {
    if (!isFailedTraceStep(step) && !step.error_source) continue;
    const source = step.error_source ?? "unknown";
    const category = step.error_category ?? "unknown";
    const key = `${step.model_call_id ?? step.id}:${source}:${category}`;
    const group = groups.get(key) ?? {
      source, category, httpStatus: step.http_status ?? undefined,
      modelCallId: step.model_call_id ?? undefined,
      provider: step.provider_name ?? undefined, model: step.model_name ?? undefined,
      affectsResult: false, sources: [], spanIds: [], details: [],
    };
    group.affectsResult ||= step.affects_result === true;
    group.provider ??= step.provider_name ?? undefined;
    group.model ??= step.model_name ?? undefined;
    if (!group.sources.includes(step.name)) group.sources.push(step.name);
    if (!group.spanIds.includes(step.id)) group.spanIds.push(step.id);
    for (const detail of [step.error_type, step.detail]) {
      if (detail && !group.details.includes(detail)) group.details.push(detail);
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}
