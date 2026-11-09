// @vitest-environment node
import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { createDatabaseReadiness, ReadinessTimeoutError, StorageNotInitializedError } from "./readiness.js";

afterEach(() => vi.useRealTimers());
function setup() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async () => ({ rows: [{ desiredGeneration: "7" as string | number }] })), release: vi.fn(),
  });
  const connect = vi.fn(async () => client);
  const probe = createDatabaseReadiness({ connect } as unknown as Pool);
  return { probe, client, connect };
}

it("shares concurrent reads, releases the connection, and checks fresh state on the next probe", async () => {
  const { probe, client, connect } = setup();
  const first = probe();
  expect(probe()).toBe(first);
  expect(await first).toBe(7);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  client.query.mockResolvedValue({ rows: [{ desiredGeneration: 8 }] });
  expect(await probe()).toBe(8);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(client.listenerCount("error")).toBe(0);
});

it("rejects a reachable but uninitialized Controller database", async () => {
  const { probe, client } = setup();
  client.query.mockResolvedValue({ rows: [] });
  await expect(probe()).rejects.toBeInstanceOf(StorageNotInitializedError);
  expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
});

it("bounds pool checkout and does not accumulate waiters or execute SQL after timeout", async () => {
  vi.useFakeTimers();
  const { probe, connect, client } = setup();
  const checkout = Promise.withResolvers<typeof client>();
  connect.mockReturnValueOnce(checkout.promise);
  const first = probe();
  const failure = expect(first).rejects.toBeInstanceOf(ReadinessTimeoutError);
  await vi.advanceTimersByTimeAsync(750);
  await failure;
  for (let i = 0; i < 20; i++) expect(probe()).toBe(first);
  expect(connect).toHaveBeenCalledTimes(1);
  checkout.resolve(client);
  await vi.advanceTimersByTimeAsync(0);
  expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  expect(client.query).not.toHaveBeenCalled();
  expect(await probe()).toBe(7);
});

it("destroys the active query connection at the deadline and recovers after cleanup", async () => {
  vi.useFakeTimers();
  const { probe, client } = setup();
  const query = Promise.withResolvers<{ rows: Array<{ desiredGeneration: number }> }>();
  client.query.mockReturnValueOnce(query.promise);
  client.release.mockImplementationOnce(destroy => { if (destroy) query.reject(new Error("Connection terminated")); });
  const failure = expect(probe()).rejects.toBeInstanceOf(ReadinessTimeoutError);
  await vi.advanceTimersByTimeAsync(750);
  await failure;
  expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  expect(client.listenerCount("error")).toBe(0);
  expect(await probe()).toBe(7);
});

it("handles checkout rejection and socket errors without retaining broken clients", async () => {
  const { probe, connect, client } = setup();
  connect.mockRejectedValueOnce(new Error("Database unavailable"));
  await expect(probe()).rejects.toThrow("Database unavailable");
  expect(client.release).not.toHaveBeenCalled();
  const query = Promise.withResolvers<{ rows: Array<{ desiredGeneration: number }> }>();
  client.query.mockReturnValueOnce(query.promise);
  const failure = expect(probe()).rejects.toThrow("Socket failed");
  await vi.waitFor(() => expect(client.query).toHaveBeenCalledTimes(1));
  const error = new Error("Socket failed");
  client.emit("error", error);
  query.reject(error);
  await failure;
  expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  expect(await probe()).toBe(7);
});
