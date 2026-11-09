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
  return event.metadata.executionStatus === "error" || event.metadata.executionStatus === "timeout";
}
