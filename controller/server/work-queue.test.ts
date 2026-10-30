// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { KeyedWorkQueue, PendingWork } from "./work-queue.js";

describe("bounded work and draining", () => {
  it("limits concurrency across callers, coalesces queued work and gives dirty identities a fair fresh pass", async () => {
    const queue = new KeyedWorkQueue<string>(2);
    const gate = Promise.withResolvers<void>();
    let active = 0, peak = 0;
    const order: string[] = [];
    const task = (key: string, blocked = false) => async () => {
      active++; peak = Math.max(peak, active); order.push(key);
      if (blocked) await gate.promise;
      active--;
    };
    const a = queue.run("a", task("a-old", true));
    const b = queue.run("b", task("b", true));
    await vi.waitFor(() => expect(active).toBe(2));
    const c = queue.run("c", task("c"));
    expect(queue.run("c", task("c-latest"))).toBe(c);
    expect(queue.run("a", task("a-new-generation"))).toBe(a);
    gate.resolve();
    await Promise.all([a, b, c]);
    expect(peak).toBe(2);
    expect(order).toEqual(["a-old", "b", "c-latest", "a-new-generation"]);
  });

  it("recovers after rejection and drains child work created by finishing parents", async () => {
    const queue = new KeyedWorkQueue<string>(1), pending = new PendingWork();
    await expect(queue.run("bad", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    const gate = Promise.withResolvers<void>(), child = Promise.withResolvers<void>();
    pending.track(queue.run("parent", async () => { await gate.promise; pending.track(child.promise); }));
    let drained = false;
    const done = pending.drain().then(() => { drained = true; });
    gate.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(drained).toBe(false);
    child.resolve(); await done;
    expect(drained).toBe(true);
  });
});
