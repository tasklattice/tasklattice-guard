import { sql } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";

type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];

/** Report delivery is retryable. Cancel SQL on the server instead of leaving
 * blocked writes holding pool slots after a caller-side timeout. Lock waits
 * must finish before the pool's 5s checkout timeout. Limits are transaction-local.
 */
export async function limitValidationWrite(tx: Transaction): Promise<void> {
  await tx.execute(sql`SELECT
    set_config('lock_timeout', '2s', true),
    set_config('statement_timeout', '30s', true),
    set_config('idle_in_transaction_session_timeout', '30s', true)`);
}
