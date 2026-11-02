import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { ControllerConfig } from "../config.js";
import * as schema from "./schema.js";
import { databasePoolState, logDatabaseFailure, reportSaveContext, reportSaveStage, reportTransactionClient } from "./diagnostics.js";

export type ControllerDatabase = ReturnType<typeof createPooledDatabase>;

/** Own the checkout even when Drizzle's BEGIN fails before its try/finally. */
export function createPooledDatabase(pool: Pool) {
  const db = drizzle(pool, { schema });
  db.transaction = (transaction, config) => withDatabaseConnection(pool, scoped => scoped.transaction(transaction, config));
  return db;
}

/** Used by transactions and migrations, which bypass db.transaction internally. */
export async function withDatabaseConnection<T>(pool: Pool, task: (db: NodePgDatabase<typeof schema>) => Promise<T>, discard = false): Promise<T> {
  const client = await reportSaveStage("pool_acquire", () => pool.connect());
  const context = reportSaveContext();
  let connectionError: Error | undefined;
  const onError = (error: Error) => {
    // pg removes its idle listener at checkout. Socket/backend failures
    // between statements otherwise become uncaught EventEmitter errors.
    if (connectionError) return;
    connectionError = error;
    logDatabaseFailure("database.transaction_connection_error", error, databasePoolState(pool), context);
  };
  client.on("error", onError);
  try {
    // A client-backed Drizzle transaction keeps nested savepoints on this
    // same connection, but leaves checkout/release to this outer scope.
    return await task(drizzle(reportTransactionClient(client), { schema }));
  } catch (error) {
    // ROLLBACK on a dead socket throws a secondary, code-less error. Keep
    // the original backend/network failure for callers and diagnostics.
    throw connectionError ?? error;
  } finally {
    // A failed ROLLBACK must not put an open/aborted transaction back into
    // circulation. pg reports 'I' only once the server is idle again.
    try {
      await reportSaveStage("pool_release", () => client.release(discard || Boolean(connectionError) || client.getTransactionStatus() !== "I"));
    } finally {
      // release reattaches the pool's idle listener before ours is removed.
      client.removeListener("error", onError);
    }
  }
}

export function createDatabase(config: ControllerConfig) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.nodeEnv === "test" ? 2 : 20,
    application_name: "tali-guard-controller",
    connectionTimeoutMillis: 5_000,
    statement_timeout: config.databaseTimeouts.statementMs,
    lock_timeout: config.databaseTimeouts.lockMs,
    idle_in_transaction_session_timeout: config.databaseTimeouts.idleTransactionMs,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  // pg-pool removes a broken idle client before emitting this event. Without
  // a listener, a database restart/network failure becomes an uncaught error.
  // Do not log the full Error: pg attaches a Client with connection secrets.
  pool.on("error", error => logDatabaseFailure("database.pool_idle_error", error, databasePoolState(pool)));
  const db = createPooledDatabase(pool);
  return { db, pool };
}
