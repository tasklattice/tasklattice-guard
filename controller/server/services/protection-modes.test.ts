// @vitest-environment node
import { describe, expect, it } from "vitest";
import { protectionModeSnapshot } from "./protection-modes.js";
import { guardrails, runnerInstances } from "../db/schema.js";
const row = { id: "g", protectionMode: "bypass", protectionModeApplied: "enforce", protectionModeGeneration: 4 } as typeof guardrails.$inferSelect;
const runner = (overrides = {}) => ({ runnerId: "r", status: "ready", lastHeartbeatAt: new Date(1000), labels: { "tasklattice.protection-modes": "1" }, protectionGeneration: 4, protectionRejectedGeneration: 0, protectionError: null, ...overrides }) as typeof runnerInstances.$inferSelect;
describe("mode convergence", () => {
  it("reports unavailable replicas without claiming full application", () => {
    const snapshot = protectionModeSnapshot(row, [runner(), runner({ runnerId: "old", labels: {} }), runner({ runnerId: "off", lastHeartbeatAt: new Date(1) }), runner({ runnerId: "failed", protectionGeneration: 3, protectionRejectedGeneration: 4, protectionError: "disk" })], true, 500);
    expect(snapshot).toMatchObject({ applied: 1, total: 4, status: "partial", appliedMode: "enforce" });
    expect(snapshot.runners.map(r => r.status)).toEqual(["applied", "unsupported", "offline", "failed"]);
  });
  it("waits for a Runner and never treats an old ACK as a new mode", () => {
    expect(protectionModeSnapshot(row, [], true, 500)).toMatchObject({ status: "waiting", applied: 0, total: 0 });
    expect(protectionModeSnapshot(row, [runner({ protectionGeneration: 3 })], true, 500)).toMatchObject({ status: "applying", applied: 0 });
  });
});
