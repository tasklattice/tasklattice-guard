import { count, eq } from "drizzle-orm";
import { MAX_GUARDRAIL_VERSIONS } from "../../shared/guardrail-version-limit.js";
import type { ControllerDatabase } from "../db/client.js";
import { guardrailVersions } from "../db/schema.js";
import { ConflictError } from "../domain/errors.js";

type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];

export function guardrailVersionLimitIssue(current: number, incoming: number) {
  if (incoming === 0 || current + incoming <= MAX_GUARDRAIL_VERSIONS) return null;
  return {
    code: "guardrail_version_limit",
    message: `This Guardrail has ${current}/${MAX_GUARDRAIL_VERSIONS} immutable versions. Adding ${incoming} would exceed the limit. Delete unused versions before publishing or importing more.`,
    detail: { current, incoming, limit: MAX_GUARDRAIL_VERSIONS },
  };
}

/** The caller must hold the Guardrail row lock (or the import lock for a new ID). */
export async function guardrailVersionCapacityIssue(tx: Transaction, guardrailId: string, incoming: number) {
  const [row] = await tx.select({ count: count() }).from(guardrailVersions).where(eq(guardrailVersions.guardrailId, guardrailId));
  return guardrailVersionLimitIssue(row?.count ?? 0, incoming);
}

export async function assertGuardrailVersionCapacity(tx: Transaction, guardrailId: string, incoming: number) {
  const issue = await guardrailVersionCapacityIssue(tx, guardrailId, incoming);
  if (issue) throw new ConflictError(issue.message, issue.code, issue.detail);
}
