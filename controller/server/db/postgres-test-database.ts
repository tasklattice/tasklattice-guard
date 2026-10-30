import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { migrateReportStorage } from "./report-storage-migration.js";
import { Pool } from "pg";
import { createPooledDatabase, type ControllerDatabase } from "./client.js";

/**
 * An isolated schema with every migration replayed from nothing, for
 * `*.postgres.test.ts` suites. Only loopback databases are accepted.
 */
export async function createTestDatabase(url: string, prefix: string, beforeMigration?: (tag: string, pool: Pool) => Promise<void>): Promise<{
  db: ControllerDatabase; pool: Pool; drop: () => Promise<void>;
}> {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Test databases must be on loopback.");
  const namespace = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
  await admin.query(`CREATE SCHEMA "${namespace}"`);
  const pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000, options: `-c search_path=${namespace}`, application_name: namespace });
  const read = (name: string) => readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8");
  const journal = JSON.parse(read("meta/_journal.json")) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    await beforeMigration?.(tag, pool);
    if (tag === "0057_report_storage_cutover") await migrateReportStorage(createPooledDatabase(pool));
    await pool.query(read(`${tag}.sql`).replaceAll('"public".', `"${namespace}".`));
  }
  return {
    db: createPooledDatabase(pool),
    pool,
    drop: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.end();
    },
  };
}
