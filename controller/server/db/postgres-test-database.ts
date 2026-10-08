import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";
import type { ControllerDatabase } from "./client.js";

/**
 * An isolated schema with every migration replayed from nothing, for
 * `*.postgres.test.ts` suites. Only loopback databases are accepted.
 */
export async function createTestDatabase(url: string, prefix: string): Promise<{
  db: ControllerDatabase; pool: Pool; drop: () => Promise<void>;
}> {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Test databases must be on loopback.");
  const namespace = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
  await admin.query(`CREATE SCHEMA "${namespace}"`);
  const pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000, options: `-c search_path=${namespace}`, application_name: namespace });
  const read = (name: string) => readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8");
  const journal = JSON.parse(read("meta/_journal.json")) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) await pool.query(read(`${tag}.sql`).replaceAll('"public".', `"${namespace}".`));
  return {
    db: drizzle(pool, { schema }),
    pool,
    drop: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.end();
    },
  };
}
