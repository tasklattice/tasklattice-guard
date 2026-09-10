import { sql } from "drizzle-orm";
import type { ControllerDatabase } from "./client.js";

type ReadTransaction = Parameters<
  Parameters<ControllerDatabase["transaction"]>[0]
>[0];
type ExecuteRead = <T>(query: PromiseLike<T>) => Promise<T>;

/** Each statement shares one deadline; a timeout terminates SQL, not just the HTTP wait. */
export async function boundedRead<T>(
  db: ControllerDatabase,
  read: (tx: ReadTransaction, execute: ExecuteRead) => Promise<T>,
  budgetMs = 20_000,
): Promise<T> {
  const deadline = performance.now() + budgetMs;
  return db.transaction(
    async (tx) => {
      const execute: ExecuteRead = async (query) => {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0)
          throw new Error("Observability read deadline exceeded");
        await tx.execute(
          sql`SELECT set_config('statement_timeout', ${String(remaining)}, true)`,
        );
        return await query;
      };
      await execute(tx.execute(sql`SET LOCAL work_mem = '16MB'`));
      await execute(tx.execute(sql`SET LOCAL jit = off`));
      // Also protects query builders executed via tx, which are single-statement reads.
      return read(tx, execute);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
