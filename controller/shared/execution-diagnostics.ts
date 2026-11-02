export type ErrorSource = "model" | "configuration" | "guard" | "unknown" | "mixed";
export type ModelStatus = "ok" | "error" | "not_called" | "unknown";

/** Facts recorded by the execution boundary, independent of test assertions. */
export type ExecutionDiagnostics = {
  error_source?: ErrorSource | null;
  error_category?: string | null;
  error_type?: string | null;
  http_status?: number | null;
  model_call_id?: string | null;
  model_result?: string | null;
  provider_name?: string | null;
  model_name?: string | null;
  affects_result?: boolean;
};
