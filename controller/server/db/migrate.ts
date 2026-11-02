import { readMigrationFiles } from "drizzle-orm/migrator";
import { seedProfiles } from "./seed-profiles.js";
import { sql } from "drizzle-orm";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ControllerConfig } from "../config.js";
import { withDatabaseConnection, type ControllerDatabase } from "./client.js";

export const SCHEMA_BASELINE = 1793373600000;

export async function runMigrations(config: ControllerConfig, db: ControllerDatabase): Promise<void> {
  // The migrator invokes session.transaction directly, bypassing the public
  // db.transaction override. Own its connection for the entire operation.
  await withDatabaseConnection(db.$client, async scoped => {
    // DDL gets a separate, bounded budget. Discard this checkout afterward so
    // the migration settings never enter the ordinary request pool.
    await scoped.execute(sql`SELECT set_config('statement_timeout', '300000', false),
      set_config('lock_timeout', '30000', false), set_config('idle_in_transaction_session_timeout', '30000', false)`);
    // Session lock serializes upgrades across replicas. This checkout is discarded.
    await scoped.execute(sql`SELECT pg_advisory_lock(hashtext(current_database()), 1735199)`);
    await scoped.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`);
    await scoped.execute(sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    const { rows: [last] } = await scoped.execute<{ created_at: string }>(sql`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`);
    if (last && Number(last.created_at) < SCHEMA_BASELINE) {
      throw new Error("Database does not match the V1 schema baseline. Initialize a fresh V1 database; development schemas are not upgraded.");
    }
    for (const migration of readMigrationFiles({ migrationsFolder: config.migrationsPath })) {
      if (Number(last?.created_at ?? 0) >= migration.folderMillis) continue;
      await scoped.transaction(async tx => {
        for (const statement of migration.sql) await tx.execute(sql.raw(statement));
        if (migration.folderMillis === SCHEMA_BASELINE) await seedProfiles(tx);
        await tx.execute(sql`INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES(${migration.hash},${migration.folderMillis})`);
      });
    }
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
