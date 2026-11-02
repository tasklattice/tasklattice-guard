// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { drainController } from "./shutdown.js";
afterEach(() => vi.useRealTimers());

it("drains report maintenance started by accepted requests before closing the database", async () => {
  const report = Promise.withResolvers<void>(), endDatabase = vi.fn(async () => {});
  const stopReports = vi.fn(() => report.promise);
  const stopped = drainController({ closeHttp: async () => {}, stopRunner: async () => {}, stopMetrics: async () => {}, stopAccounts: async () => {},
    stopPricing: async () => {}, stopReports, endDatabase, forceClose: vi.fn() });
  await vi.waitFor(() => expect(stopReports).toHaveBeenCalledOnce());
  expect(endDatabase).not.toHaveBeenCalled();
  report.resolve(); await stopped;
  expect(endDatabase).toHaveBeenCalledOnce();
});

it("closes admission first and keeps the pool open until HTTP, metrics, Runner and account work drain", async () => {
  const gates = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
  const order: string[] = [];
  const steps = {
    closeHttp: vi.fn(() => { order.push("http"); return gates[0]!.promise; }),
    stopRunner: vi.fn(() => { order.push("runner"); return gates[1]!.promise; }),
    stopMetrics: vi.fn(() => gates[2]!.promise), stopAccounts: vi.fn(() => gates[3]!.promise),
    stopPricing: vi.fn(async () => { order.push("pricing"); }),
    endDatabase: vi.fn(async () => { order.push("database"); }), forceClose: vi.fn(),
  };
  const stopped = drainController(steps);
  await vi.waitFor(() => expect(steps.stopAccounts).toHaveBeenCalled());
  gates.slice(0, 3).forEach(gate => gate.resolve());
  await Promise.resolve(); expect(steps.endDatabase).not.toHaveBeenCalled();
  gates[3]!.resolve(); await stopped;
  expect(order).toEqual(["http", "runner", "pricing", "database"]);
  expect(steps.forceClose).not.toHaveBeenCalled();
});

it("forces transport closure at the overall deadline without ending the pool underneath accepted work", async () => {
  vi.useFakeTimers();
  const gate = Promise.withResolvers<void>();
  const steps = { closeHttp: () => gate.promise, stopRunner: async () => {}, stopMetrics: async () => {}, stopAccounts: async () => {},
    stopPricing: async () => {}, endDatabase: vi.fn(async () => {}), forceClose: vi.fn() };
  const stopped = expect(drainController(steps, 100)).rejects.toThrow("shutdown deadline");
  await vi.advanceTimersByTimeAsync(100); await stopped;
  expect(steps.forceClose).toHaveBeenCalledOnce();
  expect(steps.endDatabase).not.toHaveBeenCalled();
  gate.resolve(); await vi.runAllTimersAsync();
});

it("waits for every producer after one fails and still closes the pool after pricing failure", async () => {
  const held = Promise.withResolvers<void>();
  const steps = { closeHttp: async () => { throw new Error("http failure"); }, stopRunner: () => held.promise,
    stopMetrics: async () => {}, stopAccounts: async () => {}, stopPricing: vi.fn(async () => { throw new Error("pricing failure"); }),
    endDatabase: vi.fn(async () => {}), forceClose: vi.fn() };
  const result = expect(drainController(steps)).rejects.toThrow("http failure");
  await Promise.resolve(); await Promise.resolve();
  expect(steps.endDatabase).not.toHaveBeenCalled(); expect(steps.stopPricing).not.toHaveBeenCalled();
  held.resolve(); await result;
  expect(steps.stopPricing).toHaveBeenCalledOnce(); expect(steps.endDatabase).toHaveBeenCalledOnce();
});
