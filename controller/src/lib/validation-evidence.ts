import type { ModelValidationReport } from "./controller-api";

export type ValidationCheck = ModelValidationReport["checks"][number];
export type EvidenceRecord = Record<string, unknown>;
export const record = (value: unknown): EvidenceRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? value as EvidenceRecord : {};
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const text = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
export function parse(value: unknown): EvidenceRecord {
  if (typeof value !== "string") return record(value);
  try { return record(JSON.parse(value)); } catch { return {}; }
}
export function bodyFormat(value: unknown) {
  const body = text(value);
  try { return { content: JSON.stringify(JSON.parse(body), null, 2), language: "json" }; }
  catch { return { content: body, language: "text" }; }
}
export function headers(value: unknown): [string, string][] {
  // Legacy HTTP evidence stores pairs; do not collapse repeated header names.
  return Array.isArray(value) ? value.filter(item => Array.isArray(item) && item.length >= 2).map(item => [text(item[0]), text(item[1])]) : Object.entries(record(value)).map(([name, value]) => [name, text(value)]);
}
export function exchanges(output: EvidenceRecord): EvidenceRecord[] {
  if (Array.isArray(output.model_exchanges)) return output.model_exchanges.map(record);
  const part = (value: unknown) => {
    if (value == null) return null;
    const item = record(value);
    let body = "";
    try { body = new TextDecoder().decode(Uint8Array.from(atob(text(item.bodyBase64)), c => c.charCodeAt(0))); } catch { /* Keep malformed legacy records exportable. */ }
    return { ...item, body, body_truncated: item.bodyComplete === false };
  };
  return list(output.model_http_evidence).map(value => {
    const item = record(value);
    return { ...item, request: part(item.request), response: part(item.response) };
  });
}

/** Export captured values, never current editable settings or presentation-derived results. */
export function validationEvidenceDocument(check: ValidationCheck, subject: string) {
  return {
    schema: "tasklattice.validation-evidence.v1", subject,
    check: { ...check, cases: check.cases?.map(item => ({ ...item, outputContent: (() => {
      try { return JSON.parse(item.outputContent) as unknown; } catch { return item.outputContent; }
    })() })) ?? [] },
  };
}

/** Failure attribution classes reported by the Runner. Never inferred from allow/block. */
export const failureClasses = ["configuration", "endpoint", "protocol", "threshold", "capability", "platform", "unknown"] as const;
export type FailureClass = typeof failureClasses[number];
export const failureClass = (value: unknown): FailureClass | "" => {
  const item = text(value);
  return (failureClasses as readonly string[]).includes(item) ? item as FailureClass : "";
};
/** Per-sample attribution; older records carry none and fall back to passed/failed. */
export const caseFailureClass = (sample: { outputContent?: string }): FailureClass | "" =>
  failureClass(parse(sample.outputContent).failure_class);

export function resultEvidence(output: EvidenceRecord) {
  const evaluations: (EvidenceRecord & { verdict: unknown; data: EvidenceRecord })[] = list(output.evaluation_evidence)
    .map(value => {
      const item = record(value);
      return { ...item, verdict: item.verdict, data: parse(item.evidence) };
    });
  const findings = list(output.findings).map(record);
  const actions = list(output.detector_evidence).map(record);
  const error = record(output.error);
  // Evaluator-level failures return a verdict instead of raising, so the type
  // lives on the evaluation step rather than in the top-level error object.
  const errorType = text(error.type) || evaluations.map(item => text(item.error_type)).filter(Boolean).at(-1) || "";
  const verdict = evaluations.map(item => text(item.verdict)).filter(Boolean).at(-1) || actions.map(item => text(item.verdict)).filter(Boolean).at(-1) || text(findings[0]?.verdict);
  const native = evaluations.map(item => item.data).filter(item => item.native_verdict != null || item.topic_verdict != null);
  // Native NeMo topic rails expose their normalized verdict in the rail trace.
  // Never infer a classifier label from allow/block: a fallback can block unknowns.
  if (!native.length && !evaluations.some(item => item.data.judgments) && text(record(output.validation_context).binding_id).startsWith("topic_control.")) {
    const topic = actions.filter(item => item.capability === "topic_control").at(-1);
    const labels: Record<string, string> = { matched: "off-topic", not_matched: "on-topic", unknown: "unknown" };
    if (labels[text(topic?.verdict)]) native.push({ topic_verdict: labels[text(topic?.verdict)] });
  }
  return {
    evaluations,
    verdict,
    errorType,
    failureClass: failureClass(output.failure_class),
    judgments: evaluations.flatMap(item => Object.entries(record(item.data.judgments)).map(([question, value]) => ({ question, answer: record(value).answer, probability: record(value).probability, thresholds: record(item.data.thresholds) }))),
    answers: evaluations.flatMap(item => Object.entries(record(item.data.answers)).map(([question, answer]) => ({ question, answer }))),
    native,
    grounding: findings.flatMap(item => list(item.grounding).map(record)),
    claims: findings.flatMap(item => list(item.claims).map(record)),
    reasoning: findings.flatMap(item => list(item.reasoning).map(record)),
  };
}
