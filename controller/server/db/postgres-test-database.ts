import { currentAuthorityScope, runWithProjectContext } from "../services/project-context.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { seedProfiles } from "./seed-profiles.js";
import { Pool } from "pg";
import { createPooledDatabase, type ControllerDatabase } from "./client.js";

/**
 * An isolated schema with every migration replayed from nothing, for
 * `*.postgres.test.ts` suites. Only loopback databases are accepted.
 */
export async function createTestDatabase(url: string, prefix: string, { maxConnections = 8 }: { maxConnections?: number } = {}): Promise<{
  db: ControllerDatabase; pool: Pool; schema: string; drop: () => Promise<void>;
}> {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Test databases must be on loopback.");
  const namespace = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
  await admin.query(`CREATE SCHEMA "${namespace}"`);
  const pool = new Pool({ connectionString: url, max: maxConnections, connectionTimeoutMillis: 5000, options: `-c search_path=${namespace}`, application_name: namespace });
  const read = (name: string) => readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8");
  const journal = JSON.parse(read("meta/_journal.json")) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    await pool.query(read(`${tag}.sql`).replaceAll('"public".', `"${namespace}".`));
  }
  await seedTestProjects(pool);
  await seedProfiles(createPooledDatabase(pool));
  return {
    db: createPooledDatabase(pool),
    pool,
    schema: namespace,
    drop: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.end();
    },
  };
}

/** Explicit sample identities for integration fixtures, never production bootstrap. */
export async function seedTestProjects(pool: Pool) {
  await pool.query("INSERT INTO project(id,name) VALUES ('projectA','test-project-a'),('projectB','test-project-b'),('projectC','test-project-c') ON CONFLICT DO NOTHING");
}

/** Legacy service fixtures now opt into their explicit project at creation. */
export function withTestProject<T>(callback: () => T): T {
  return currentAuthorityScope() ? callback() : runWithProjectContext({projectId: "projectA", role: "user"}, callback);
}
