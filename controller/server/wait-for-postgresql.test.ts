// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { waitForPostgres } from "../scripts/runtime/wait-for-postgresql.mjs";

describe("PostgreSQL initialization readiness", () => {
  it("retries connection and query failures, closes each client, and only succeeds after a query", async () => {
    const clients = Array.from({ length: 3 }, () => ({
      on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ rows: [{ value: 1 }] }), end: vi.fn().mockResolvedValue(undefined),
    }));
    clients[0].connect.mockRejectedValue(new Error("sensitive connection details"));
    clients[1].query.mockRejectedValue(new Error("database not ready"));
    const createClient = vi.fn().mockReturnValueOnce(clients[0]).mockReturnValueOnce(clients[1]).mockReturnValueOnce(clients[2]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    await waitForPostgres("postgresql://test", { createClient, sleep, log });
    expect(createClient).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2000], [2000]]);
    expect(clients[0].query).not.toHaveBeenCalled();
    expect(clients[2].query).toHaveBeenCalledWith("SELECT 1");
    for (const client of clients) expect(client.end).toHaveBeenCalledOnce();
    expect(log.mock.calls).toEqual([
      ["Waiting for PostgreSQL to accept queries..."],
      ["Waiting for PostgreSQL to accept queries..."],
      ["PostgreSQL is ready."],
    ]);
  });

  it("fails immediately when the database configuration is missing", async () => {
    const createClient = vi.fn();
    await expect(waitForPostgres(undefined, { createClient })).rejects.toThrow("CONTROLLER_DATABASE_URL is required.");
    expect(createClient).not.toHaveBeenCalled();
  });
});
