import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { createAuth } from "./auth.js";
import { runMigrations } from "./db/migrate.js";
import { ensureBootstrapAdmin } from "./bootstrap.js";

const config = loadConfig();
if (!config.bootstrapAdmin) {
  throw new Error("Configure a bootstrap email and either password or passwordHash.");
}

const { db, pool } = createDatabase(config);
const auth = createAuth(config, db);

try {
  await runMigrations(config, db);
  const status = await ensureBootstrapAdmin({ auth, db, ...config.bootstrapAdmin });
  process.stdout.write(`${status === "created" ? "Created" : "Found existing"} Better Auth administrator ${config.bootstrapAdmin.email}.\n`);
} finally {
  await pool.end();
}
