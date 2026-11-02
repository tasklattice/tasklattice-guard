import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { createAuth } from "./auth.js";
import { runMigrations } from "./db/migrate.js";
import { ensureBootstrapAdmin, ensureBootstrapUser } from "./bootstrap.js";

const config = loadConfig();
if (!config.bootstrapAdmin && !config.bootstrapUser) {
  throw new Error("Configure a bootstrap username and password.");
}

const { db, pool } = createDatabase(config);
const auth = createAuth(config, db);

try {
  await runMigrations(config, db);
  for (const [role, account, ensure] of [
    ["admin", config.bootstrapAdmin, ensureBootstrapAdmin],
    ["user", config.bootstrapUser, ensureBootstrapUser],
  ] as const) {
    if (!account) continue;
    const status = await ensure({ auth, ...account });
    process.stdout.write(`${status === "created" ? "Created" : "Updated"} Better Auth ${role} ${account.username}.\n`);
  }
} finally {
  await pool.end();
}
