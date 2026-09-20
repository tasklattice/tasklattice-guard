import { pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";
import pg from "pg";

export async function waitForPostgres(connectionString, {
  createClient = options => new pg.Client(options),
  sleep = setTimeout,
  log = console.log,
} = {}) {
  if (!connectionString) throw new Error("CONTROLLER_DATABASE_URL is required.");
  for (;;) {
    const client = createClient({ connectionString, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
    let ready = false;
    // pg can emit an idle connection error between connecting and querying.
    client.on("error", () => {});
    try {
      await client.connect();
      await client.query("SELECT 1");
      ready = true;
    } catch {
      // Never print connection strings or server errors containing credentials.
      log("Waiting for PostgreSQL to accept queries...");
    } finally {
      await client.end().catch(() => {});
    }
    if (ready) {
      log("PostgreSQL is ready.");
      return;
    }
    await sleep(2_000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  waitForPostgres(process.env.CONTROLLER_DATABASE_URL).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
