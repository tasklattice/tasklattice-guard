import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { createAuth } from "./auth.js";
import { runMigrations } from "./db/migrate.js";
import { BootstrapAccountSynchronizer } from "./bootstrap.js";
import { ControlPlaneService } from "./services/control-plane.js";
import { ProjectService } from "./services/projects.js";

const config = loadConfig();
if (!config.bootstrapAdmin && !config.bootstrapUser) {
  throw new Error("Configure a bootstrap username and password.");
}

const { db, pool } = createDatabase(config);
const auth = createAuth(config, db);

try {
  await runMigrations(config, db);
  let projects: ProjectService | undefined;
  if (config.bootstrapUser?.project) {
    const service = new ControlPlaneService(db, config);
    await service.initialize();
    projects = new ProjectService(db, (tx, id) => service.initializeProject(tx, id), config.runtimeServiceUrl);
  }
  for (const result of await new BootstrapAccountSynchronizer(auth, projects).synchronize(config)) {
    process.stdout.write(`${result.status === "created" ? "Created" : "Updated"} Better Auth ${result.role} ${result.username}.\n`);
  }
} finally {
  await pool.end();
}
