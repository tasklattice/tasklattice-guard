/** Enforcement outcomes are independent of execution errors and timeouts. */
export const runtimeOutcomes = ["allow", "block", "transform"] as const;
export type RuntimeOutcome = (typeof runtimeOutcomes)[number];
export function runtimeOutcome(value: string): RuntimeOutcome | null {
  return runtimeOutcomes.find(outcome => outcome === value) ?? null;
}

/** Log filtering includes operational failures without changing enforcement outcomes. */
export const runtimeLogOutcomes = [...runtimeOutcomes, "error"] as const;
export type RuntimeLogOutcome = (typeof runtimeLogOutcomes)[number];
export function hasRuntimeError(event: { decision: string; metadata: Record<string, unknown> }): boolean {
  const { metadata } = event;
  const records = (value: unknown) => Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
  return ["error", "failed", "failure", "timeout", "timed_out"].includes(event.decision.toLowerCase())
    || metadata.executionStatus === "error" || metadata.timedOut === true || metadata.timed_out === true
    || records(metadata.findings).some(item => item.verdict === "error")
    || records(metadata.trace).some(item => item.verdict === "error" || item.timedOut === true
      || ["error", "failed", "timeout"].includes(String(item.status)) || ["error", "failed", "timeout"].includes(String(item.outcome)));
}
