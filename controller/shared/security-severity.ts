// Risk belongs to the versioned Rule, never to its action or detector confidence.
export const riskSeverities = ["critical", "high", "medium", "low", "informational"] as const;
export type RiskSeverity = typeof riskSeverities[number];
export type EventSeverity = RiskSeverity | "unclassified";
export const eventSeverities = [...riskSeverities, "unclassified"] as const;
export function eventSeverity(value: unknown): EventSeverity {
  return riskSeverities.includes(value as RiskSeverity) ? value as RiskSeverity : "unclassified";
}
export function highestSeverity(values: EventSeverity[]): EventSeverity | null {
  return eventSeverities.find(level => values.includes(level)) ?? null;
}

// Canonical order also keeps URL and query-cache keys stable for multi-selection.
export function selectedSeverities(value: unknown): EventSeverity[] {
  const values = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  return eventSeverities.filter(level => values.includes(level));
}
