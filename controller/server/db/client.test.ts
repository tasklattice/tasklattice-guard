// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { createDatabase } from "./client.js";

describe("Controller PostgreSQL pool", () => {
  it("handles idle connection errors without crashing or logging client credentials", async () => {
    const { pool } = createDatabase(loadConfig({
      NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
      CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
    }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // pg-pool attaches the failed Client (including its connection options) to
    // the Error before emitting it. Log only safe diagnostic fields.
    const client = { password: "must-not-be-logged" };
    const error = Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET", client });
    try {
      expect(() => pool.emit("error", error, client)).not.toThrow();
      expect(JSON.parse(logged.mock.calls[0]![0])).toMatchObject({ event: "database.pool_idle_error",
        error: { category: "network_error", code: "ECONNRESET", sqlState: null },
        pool: { max: 2, total: 0, idle: 0, busy: 0, waiting: 0 },
      });
      expect(JSON.stringify(logged.mock.calls)).not.toContain(client.password);
    } finally { await pool.end(); logged.mockRestore(); }
  });
});
