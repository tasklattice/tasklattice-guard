import { describe, expect, it } from "vitest";
import { describeTraceFailure, traceDiagnostics } from "./execution-trace-errors";
import type { ExecutionTraceStep } from "./execution-trace";

const statuslessError = "All eligible Safety Providers failed: pii_semantic.input:9ec3a7b2-9532-4739-8c2d-db7c887697d5:0: HTTPStatusError";
const step = { id: "provider", kind: "action", name: "PII check", outcome: "error", latency_ms: 401, detail: statuslessError } satisfies ExecutionTraceStep;

it("explains provider errors without a status code without guessing an HTTP status from IDs or durations", () => {
  expect(describeTraceFailure(statuslessError)).toEqual({ kind: "http", subject: "model" });
  const diagnostics = traceDiagnostics([step, { ...step, id: "parent" }], statuslessError);
  expect(diagnostics).toEqual([{ kind: "http", subject: "model", sources: ["pii_semantic.input"], details: [statuslessError] }]);
});

describe("uses only recorded error evidence", () => {
  it.each([
    ["HTTPStatusError: HTTP 401", "authentication", "401"],
    ["HTTP status code 403", "permission", "403"],
    ["Client error '404 Not Found'", "notFound", "404"],
    ["http_429", "rateLimit", "429"],
    ["HTTP 503", "server", "503"],
    ["http_5xx", "server", "5xx"],
    ["http_4xx", "request", "4xx"],
    ["HTTP 504", "timeout", "504"],
  ])("maps %s", (detail, kind, httpStatus) => {
    expect(describeTraceFailure(detail, "Safety Provider")).toEqual({ kind, subject: "model", httpStatus });
  });
  it.each([
    ["ReadTimeout", "timeout"], ["ConnectError", "connection"], ["invalid_response", "invalidResponse"],
  ])("explains %s", (detail, kind) => {
    expect(describeTraceFailure(detail, "Model safety check")).toEqual({ kind, subject: "model" });
  });
});

it("does not turn a normal Block, a cancelled step or a recovered error into execution failures", () => {
  expect(traceDiagnostics(["block", "cancelled", "completed"].map(outcome => ({ ...step, outcome })))).toEqual([]);
  expect(describeTraceFailure("Safety Provider classified capability pii as unsafe; normalized to TALI-PRIVACY.")).toBeNull();
});

it("keeps different provider failures distinct in an aggregate error", () => {
  const detail = `${statuslessError}; pii_semantic.output:backup:0: ReadTimeout; Expected allow; received block.`;
  const diagnostics = traceDiagnostics([{ ...step, detail }], detail);
  expect(diagnostics).toHaveLength(2);
  expect(diagnostics[0]).toMatchObject({ kind: "http", sources: ["pii_semantic.input"], details: [detail] });
  expect(diagnostics[1]).toMatchObject({ kind: "timeout", sources: ["pii_semantic.output"] });
});

it("keeps unknown failures inspectable without attributing them to a model", () => {
  expect(traceDiagnostics([{ ...step, detail: "Custom action failed." }])).toEqual([
    { kind: "unknown", subject: "step", sources: ["PII check"], details: ["Custom action failed."] },
  ]);
});

it("shows the full case explanation once when it repeats a span's error", () => {
  const description = `${statuslessError}; Expected allow; received block.`;
  expect(traceDiagnostics([step], description)[0].details).toEqual([description]);
});
