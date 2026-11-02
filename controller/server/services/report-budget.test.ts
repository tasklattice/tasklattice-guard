// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ReportBudget } from "./report-budget.js";
afterEach(() => vi.useRealTimers());
it("bounds queued work and decoded bytes before tasks allocate or acquire database clients", async () => {
  const gate = new ReportBudget(2, 10, 1), hold = Promise.withResolvers<void>();
  const first = gate.run(8, () => hold.promise);
  const next = vi.fn(async () => 2);
  const second = gate.run(4, next);
  expect(gate.state()).toEqual({ active: 1, queued: 1, in_flight_bytes: 8 });
  await expect(gate.run(1, async () => {})).rejects.toMatchObject({ status: 429 });
  expect(next).not.toHaveBeenCalled();
  hold.resolve(); await first; expect(await second).toBe(2);
  expect(gate.state()).toEqual({ active: 0, queued: 0, in_flight_bytes: 0 });
});
it("expires queued tasks without executing them and releases capacity after failures", async () => {
  vi.useFakeTimers();
  const gate = new ReportBudget(1), hold = Promise.withResolvers<void>();
  const first = gate.run(1, () => hold.promise), task = vi.fn(async () => {});
  const waiting = expect(gate.run(1, task)).rejects.toMatchObject({ code: "report_busy" });
  await vi.advanceTimersByTimeAsync(5001); await waiting;
  expect(task).not.toHaveBeenCalled();
  hold.resolve(); await first;
  await expect(gate.run(1, async () => { throw new Error("failure"); })).rejects.toThrow("failure");
  expect(gate.state().active).toBe(0);
  await expect(gate.run(NaN, task)).rejects.toMatchObject({ status: 413 });
});
