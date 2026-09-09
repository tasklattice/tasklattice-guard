import { sql } from "drizzle-orm";
import type { ControllerDatabase } from "./client.js";

type Transaction = Parameters<
  Parameters<ControllerDatabase["transaction"]>[0]
>[0];

/** Drizzle has no built-in advisory-lock operator; keep this PostgreSQL primitive here. */
export async function advisoryTransactionLock(
  tx: Transaction,
  key: string,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}
