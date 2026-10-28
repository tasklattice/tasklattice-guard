import type { ExecutionTraceStep } from "./execution-trace";

export type TraceFailureKind = "http" | "authentication" | "permission" | "notFound" | "rateLimit" | "server" | "request" | "timeout" | "connection" | "invalidResponse" | "unknown";
export type TraceFailure = {
  kind: TraceFailureKind;
  subject: "model" | "service" | "step";
  httpStatus?: string;
};

export function isFailedTraceStep(step: ExecutionTraceStep): boolean {
  return /^(error|failed|failure|timeout|timed_out|rate_limited|server_error|client_error|transport_error|invalid_response|unknown_error)$/i.test(step.outcome);
}

// Legacy reports contain exception names rather than structured diagnostics.
// Only explicit HTTP markers are status codes; IDs and durations are not evidence.
export function describeTraceFailure(detail: string, context = ""): TraceFailure | null {
  const httpStatus = detail.match(/\bhttp(?:statuserror| status(?: code)?| error)?[\s:_-]+([45]\d{2}|[45]xx)\b/i)?.[1]?.toLowerCase()
    ?? detail.match(/\b(?:client|server) error ['"]([45]\d{2})\b/i)?.[1];
  const model = /\bSafety Providers?\b|\bmodel(?:[-_ ]|\b)|\bpii_semantic\b/i.test(`${context} ${detail}`);
  const http = httpStatus || /\bHTTPStatusError\b/i.test(detail);
  const subject = model ? "model" : http ? "service" : "step";
  if (httpStatus === "401") return { kind: "authentication", subject, httpStatus };
  if (httpStatus === "403") return { kind: "permission", subject, httpStatus };
  if (httpStatus === "404") return { kind: "notFound", subject, httpStatus };
  if (httpStatus === "408" || httpStatus === "504") return { kind: "timeout", subject, httpStatus };
  if (httpStatus === "429") return { kind: "rateLimit", subject, httpStatus };
  if (httpStatus?.startsWith("5")) return { kind: "server", subject, httpStatus };
  if (httpStatus?.startsWith("4")) return { kind: "request", subject, httpStatus };
  if (http) return { kind: "http", subject };
  if (/\brate_limited\b/i.test(detail)) return { kind: "rateLimit", subject };
  if (/\bserver_error\b/i.test(detail)) return { kind: "server", subject };
  if (/\bclient_error\b/i.test(detail)) return { kind: "request", subject };
  if (/\b(?:ReadTimeout|ConnectTimeout|WriteTimeout|PoolTimeout|TimeoutError|TimeoutException|timed out|timeout|action_deadline)\b/i.test(detail)) return { kind: "timeout", subject };
  if (/\b(?:ConnectError|ConnectionError|NetworkError|TransportError|transport_error)\b/i.test(detail)) return { kind: "connection", subject: model ? "model" : "service" };
  if (/\b(?:invalid_response|invalid classification)\b/i.test(detail)) return { kind: "invalidResponse", subject };
  if (/All eligible Safety Providers failed/i.test(detail)) return { kind: "unknown", subject };
  return null;
}

export type TraceDiagnostic = TraceFailure & { sources: string[]; details: string[] };

export function traceDiagnostics(steps: ExecutionTraceStep[], description?: string): TraceDiagnostic[] {
  const groups = new Map<string, TraceDiagnostic>();
  const keepDetail = (group: TraceDiagnostic, detail: string) => {
    if (!detail || group.details.some(value => value === detail || value.startsWith(`${detail};`))) return;
    group.details = group.details.filter(value => !detail.startsWith(`${value};`));
    group.details.push(detail);
  };
  const add = (failure: TraceFailure, detail: string, name?: string) => {
    const key = `${failure.subject}:${failure.kind}:${failure.httpStatus ?? ""}`;
    const group = groups.get(key) ?? { ...failure, sources: [], details: [] };
    // Show the check and phase up front; preserve opaque provider IDs in technical details.
    const checks = [...detail.matchAll(/\b([a-z][\w-]*\.(?:input|output)):[\w:-]+/gi)].map(match => match[1]);
    for (const source of checks.length ? checks : name ? [name] : []) {
      if (!group.sources.includes(source)) group.sources.push(source);
    }
    keepDetail(group, detail);
    groups.set(key, group);
  };
  const addDetail = (detail: string, context: string, name?: string, fallback?: TraceFailure) => {
    // A fallback chain can fail in different ways. Do not label every provider
    // with the first provider's HTTP status or exception type.
    const aggregate = detail.split("All eligible Safety Providers failed: ")[1];
    const providerErrors = aggregate?.split(/;\s*/).filter(part => /^[\w.:-]+:\s+\w*(?:Error|Exception|Timeout)\b/.test(part));
    if (providerErrors?.length) {
      providerErrors.forEach((part, index) => {
        const failure: TraceFailure = describeTraceFailure(part, "Safety Provider") ?? { kind: "unknown", subject: "model" };
        add(failure, part, name);
        if (index === 0 && detail !== part) {
          const group = groups.get(`${failure.subject}:${failure.kind}:${failure.httpStatus ?? ""}`)!;
          // Retain the complete case explanation once, including other assertions.
          group.details = group.details.filter(value => value !== part);
          keepDetail(group, detail);
        }
      });
      return;
    }
    const failure = describeTraceFailure(detail, context) ?? fallback;
    if (failure) add(failure, detail, name);
  };
  for (const step of steps) {
    if (!isFailedTraceStep(step)) continue;
    const detail = step.detail ?? "";
    const context = `${step.kind} ${step.name}`;
    const fallback = describeTraceFailure(step.outcome, context)
      ?? { kind: "unknown", subject: "step" } as const;
    addDetail(detail, context, step.name, fallback);
  }
  if (description) addDetail(description, "");
  return [...groups.values()];
}
