import { AccessTokenService } from "./services/access-tokens.js";
import { serve, type ServerType } from "@hono/node-server";

import { createAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { databasePoolState, logDatabaseFailure } from "./db/diagnostics.js";
import { drainController } from "./shutdown.js";
import { runMigrations } from "./db/migrate.js";
import { createHttpApp } from "./http/app.js";
import { RunnerControlServer } from "./control-channel/control-server.js";
import { ControlPlaneService } from "./services/control-plane.js";
import { ControllerMetrics } from "./metrics.js";
import { BootstrapAccountSynchronizer } from "./bootstrap.js";
import { RunnerPlaygroundClient } from "./playground/service.js";
import { ModelConfigurationService } from "./model-config/service.js";

const config = loadConfig();
const { db, pool } = createDatabase(config);
await runMigrations(config, db);
const service = new ControlPlaneService(db, config);
await service.initialize();
await service.pricing.start();
const models = new ModelConfigurationService(db, config.betterAuthSecret, config.policyCatalogDir);
await models.initialize();

const auth = createAuth(config, db);
const bootstrapAccounts = new BootstrapAccountSynchronizer(auth);
async function synchronizeAccounts() {
  for (const result of await bootstrapAccounts.synchronize(loadConfig())) {
    process.stdout.write(`Better Auth bootstrap ${result.role} ${result.username}: ${result.status}.\n`);
  }
}
await synchronizeAccounts();
let pendingAccountSync: Promise<void> | null = null;
const accountSyncTimer = setInterval(() => {
  if (pendingAccountSync) return;
  pendingAccountSync = synchronizeAccounts().catch(() => {
    process.stderr.write("Bootstrap account synchronization failed; retrying mounted credentials.\n");
  }).finally(() => { pendingAccountSync = null; });
}, 2_000);
accountSyncTimer.unref();
const metrics = new ControllerMetrics();
const runnerControl = new RunnerControlServer(config, service, metrics, models);
await runnerControl.start();

const playgroundRunner = new RunnerPlaygroundClient({
  baseUrl: config.runtimeServiceUrl,
  token: config.runnerToken,
});
let shuttingDown = false;
const app = createHttpApp({
  isStopping: () => shuttingDown,
  config,
  auth,
  accessTokens: new AccessTokenService(db),
  service,
  runnerControl,
  metrics,
  models,
  playgroundRunner,
});
service.startReportMaintenance();
const httpServer: ServerType = serve({
  fetch: app.fetch,
  hostname: config.http.host,
  port: config.http.port,
});

process.stdout.write(
  `Guard Controller listening on http://${config.http.host}:${config.http.port}; `
  + `Runner control on ${config.grpc.host}:${config.grpc.port}.\n`,
);

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(accountSyncTimer);
  process.stdout.write(`Guard Controller received ${signal}; shutting down.\n`);
  await drainController({
    closeHttp: () => new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve())),
    stopRunner: () => runnerControl.stop(),
    stopMetrics: () => metrics.stop(),
    stopAccounts: () => Promise.resolve(pendingAccountSync),
    stopPricing: () => service.pricing.stop(),
    stopReports: () => service.stopReportWork(),
    endDatabase: () => pool.end(),
    forceClose: () => {
      runnerControl.forceStop();
      if ("closeAllConnections" in httpServer && typeof httpServer.closeAllConnections === "function") httpServer.closeAllConnections();
    },
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void shutdown(signal).then(() => process.exit(0)).catch((error: unknown) => {
    logDatabaseFailure("controller.shutdown_error", error, databasePoolState(pool));
    process.exit(1);
  }));
}
