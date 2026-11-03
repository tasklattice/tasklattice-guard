// @vitest-environment node
import { dirname, resolve } from "node:path";
import { loadSync, type MessageTypeDefinition } from "@grpc/proto-loader";
import { describe, expect, it } from "vitest";
import { admissionSnapshotSchema } from "../../shared/admission-monitor.js";
import type { RunnerHeartbeat, RunnerHeartbeat__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/RunnerHeartbeat.js";
import { admissionSnapshotBytesFromWire } from "./admission-snapshot-codec.js";

const proto = resolve("../proto/tasklattice/guard/control/v1/runner_control.proto");
const definitions = loadSync(proto, { includeDirs: [dirname(proto)], defaults: true, oneofs: true, longs: String });
const codec = definitions["tasklattice.guard.control.v1.RunnerHeartbeat"] as MessageTypeDefinition<RunnerHeartbeat, RunnerHeartbeat__Output>;
const histogram = () => ({ buckets: Array(15).fill("0"), count: "0", totalSeconds: 0 });
const snapshot = () => ({ version: 1, available: true, capacity: 2, monotonicSeconds: 123.5, tenants: [{
  tenantId: "tenantA", active: 0, queued: 0, limit: 1,
  outcomes: { admitted: "0", queueFull: "0", queueTimeout: "0", rateLimited: "0", cancelled: "0", unavailable: "0" },
  wait: histogram(), held: histogram(),
}] });
const read = (heartbeat: RunnerHeartbeat) => {
  const wire = codec.deserialize(codec.serialize(heartbeat));
  const payload = admissionSnapshotBytesFromWire(wire.tenantAdmissionSnapshot);
  return payload ? JSON.parse(new TextDecoder().decode(payload)) : undefined;
};

describe("typed admission heartbeat diagnostics", () => {
  it("preserves explicit zero counters, presence and histogram measurements through binary encoding", () => {
    const result = read({ tenantAdmissionSnapshot: snapshot() });
    expect(admissionSnapshotSchema.parse(result)).toMatchObject({ available: true, capacity: 2,
      tenants: [{ active: 0, queued: 0, outcomes: { admitted: 0, queue_full: 0 }, wait: { count: 0, totalSeconds: 0 } }] });
    expect(JSON.stringify(result)).not.toContain("_active");
  });

  it("keeps absent snapshots and explicit unavailable reports distinct", () => {
    expect(read({})).toBeUndefined();
    expect(read({ tenantAdmissionSnapshot: { version: 1, available: false, reason: "disabled" } }))
      .toEqual({ version: 1, available: false, reason: "disabled" });
    expect(admissionSnapshotSchema.safeParse(read({ tenantAdmissionSnapshot: { version: 1 } })).success).toBe(false);
  });

  it("rejects missing required zero-valued measurements instead of manufacturing observations", () => {
    const active = snapshot(); delete (active.tenants[0] as { active?: number }).active;
    const count = snapshot(); delete (count.tenants[0]!.wait as { count?: string }).count;
    const outcome = snapshot(); delete (outcome.tenants[0]!.outcomes as { admitted?: string }).admitted;
    for (const value of [active, count, outcome]) expect(admissionSnapshotSchema.safeParse(read({ tenantAdmissionSnapshot: value })).success).toBe(false);
  });

  it("keeps cardinality, histogram consistency, finite counters and union bounds enforced", () => {
    const many = snapshot(); many.tenants = Array(65).fill(many.tenants[0]);
    expect(read({ tenantAdmissionSnapshot: many })).toEqual({ version: 1, available: false, reason: "cardinality_limit" });
    const inconsistent = snapshot(); inconsistent.tenants[0]!.wait.count = "1";
    const overflow = snapshot(); overflow.tenants[0]!.outcomes.unavailable = "10000000001";
    const nonfinite = snapshot(); nonfinite.monotonicSeconds = Number.POSITIVE_INFINITY;
    const surplus = { version: 1, available: false, reason: "disabled", capacity: 0 };
    for (const value of [inconsistent, overflow, nonfinite, surplus]) expect(admissionSnapshotSchema.safeParse(read({ tenantAdmissionSnapshot: value })).success).toBe(false);
  });
});
