import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { ControllerConfig } from "../config.js";
import * as schema from "./schema.js";

export type ControllerDatabase = ReturnType<typeof createDatabase>["db"];

export function createDatabase(config: ControllerConfig) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.nodeEnv === "test" ? 2 : 20,
    application_name: "tali-guard-controller",
    connectionTimeoutMillis: 5_000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
