import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ControllerConfig } from "../config.js";
import { withDatabaseConnection, type ControllerDatabase } from "./client.js";

export async function runMigrations(config: ControllerConfig, db: ControllerDatabase): Promise<void> {
  // The migrator invokes session.transaction directly, bypassing the public
  // db.transaction override. Own its connection for the entire operation.
  await withDatabaseConnection(db.$client, async scoped => {
    // DDL gets a separate, bounded budget. Discard this checkout afterward so
    // the migration settings never enter the ordinary request pool.
    await scoped.execute(sql`SELECT set_config('statement_timeout', '300000', false),
      set_config('lock_timeout', '30000', false), set_config('idle_in_transaction_session_timeout', '30000', false)`);
    await migrate(scoped, { migrationsFolder: config.migrationsPath });
  }, true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { loadConfig } = await import("../config.js");
  const { createDatabase } = await import("./client.js");
  const config = loadConfig();
  const { db, pool } = createDatabase(config);
  try {
    await runMigrations(config, db);
  } finally {
    await pool.end();
  }
}
