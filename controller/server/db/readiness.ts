import type { Pool, PoolClient } from "pg";

export class ReadinessTimeoutError extends Error {}
export class StorageNotInitializedError extends Error {}

/** Share one probe, including pool checkout, and destroy timed-out query sockets. */
export function createDatabaseReadiness(pool: Pool, timeoutMs = 750): () => Promise<number> {
  let pending: Promise<number> | undefined;
  return () => {
    if (pending) return pending;
    pending = new Promise<number>((resolve, reject) => {
      let client: PoolClient | undefined;
      let released = false;
      let expired = false;
      const release = (destroy = false) => {
        if (client && !released) {
          released = true;
          client.release(destroy);
        }
      };
      const onError = (error: Error) => { release(true); reject(error); };
      const timer = setTimeout(() => {
        expired = true;
        release(true);
        reject(new ReadinessTimeoutError("Storage readiness timed out."));
      }, timeoutMs);
      void Promise.resolve().then(async () => {
        try {
          client = await pool.connect();
          // A pool checkout cannot be cancelled. Release a late checkout without
          // issuing SQL, and keep sharing the failed probe until it completes.
          if (expired) return;
          client.on("error", onError);
          // A closed TCP socket alone may leave PostgreSQL waiting on a lock.
          // Bound server work too, without changing the next borrower's budget.
          await client.query("BEGIN READ ONLY");
          await client.query("SELECT set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
          const result = await client.query<{ desiredGeneration: string | number }>(
            'SELECT desired_generation AS "desiredGeneration" FROM controller_state WHERE id = $1', ["singleton"],
          );
          if (!result.rows.length) throw new StorageNotInitializedError("Controller storage is not initialized.");
          // pg returns bigint columns as strings; match Drizzle's numeric mode.
          const generation = Number(result.rows[0]!.desiredGeneration);
          if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("Invalid Controller generation.");
          await client.query("COMMIT");
          resolve(generation);
        } catch (error) {
          release(true);
          reject((error as { code?: string } | null)?.code === "57014"
            ? new ReadinessTimeoutError("Storage readiness timed out.") : error);
        } finally {
          clearTimeout(timer);
          release();
          client?.removeListener("error", onError);
          pending = undefined;
        }
      });
    });
    return pending;
  };
}
