import { serve, type ServerType } from "@hono/node-server";

import { createAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createHttpApp } from "./http/app.js";
import { OpenAICompatibleIntentAnalyzer } from "./control-plane-ai/intent-analyzer.js";
import { RunnerControlServer } from "./control-channel/control-server.js";
import { ControlPlaneService } from "./services/control-plane.js";
import { ControllerMetrics } from "./metrics.js";
import { ensureBootstrapAdmin } from "./bootstrap.js";
import { OpenAICompatiblePlaygroundModel, RunnerPlaygroundClient } from "./playground/service.js";
import { ModelConfigurationService } from "./model-config/service.js";

const config = loadConfig();
const { db, pool } = createDatabase(config);
await runMigrations(config, db);
const service = new ControlPlaneService(db, config);
await service.initialize();
const models = new ModelConfigurationService(db, config.betterAuthSecret, config.policyCatalogDir);
await models.initialize();

const auth = createAuth(config, db);
if (config.bootstrapAdmin) {
  const status = await ensureBootstrapAdmin({ auth, db, ...config.bootstrapAdmin });
  if (status === "created") process.stdout.write(`Created Better Auth bootstrap administrator ${config.bootstrapAdmin.email}.\n`);
}
const metrics = new ControllerMetrics();
const runnerControl = new RunnerControlServer(config, service, metrics, models);
await runnerControl.start();

const intentAnalyzer = config.controlPlaneAi
  ? new OpenAICompatibleIntentAnalyzer(config.controlPlaneAi)
  : null;
const playgroundModel = config.playgroundChat
  ? new OpenAICompatiblePlaygroundModel(config.playgroundChat)
  : null;
const playgroundRunner = new RunnerPlaygroundClient({
  baseUrl: config.runtimeServiceUrl,
  token: config.runnerToken,
});
const app = createHttpApp({
  config,
  auth,
  service,
  runnerControl,
  metrics,
  models,
  intentAnalyzer,
  playgroundModel,
  playgroundRunner,
});
const httpServer: ServerType = serve({
  fetch: app.fetch,
  hostname: config.http.host,
  port: config.http.port,
});

process.stdout.write(
  `Guard Controller listening on http://${config.http.host}:${config.http.port}; `
  + `Runner control on ${config.grpc.host}:${config.grpc.port}.\n`,
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`Guard Controller received ${signal}; shutting down.\n`);
  await runnerControl.stop();
  await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  await pool.end();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void shutdown(signal).then(() => process.exit(0)).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  }));
}
