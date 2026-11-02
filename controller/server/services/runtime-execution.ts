import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** Guardrails supplies execution status; consumers never reclassify evidence. */
export function executionError(metadata: SQLWrapper): SQL<boolean> {
  return sql<boolean>`COALESCE(${metadata}->>'executionStatus' IN ('error', 'timeout'), false)`;
}

export function executionTimeout(metadata: SQLWrapper): SQL<boolean> {
  return sql<boolean>`COALESCE(${metadata}->>'executionStatus' = 'timeout', false)`;
}
