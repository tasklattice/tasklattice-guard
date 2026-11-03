// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { admissionBucketSeconds, admissionMonitorStateSchema, type AvailableAdmissionSnapshot } from "../../shared/admission-monitor.js";
import type { ControllerDatabase } from "../db/client.js";
import { TenantAdmissionMonitor, type AdmissionInventory } from "./admission-monitor.js";
import { runWithTenantContext } from "./tenant-context.js";

const histogram = (count = 0, seconds = 0.1) => ({ count, totalSeconds: count * seconds,
  buckets: [...admissionBucketSeconds.map(bound => seconds <= bound ? count : 0), count] });
const tenant = (tenantId: string, count = 0, active = 1) => ({ tenantId, active, queued: active ? 2 : 0, limit: 2,
  outcomes: { admitted: count, queue_full: 0, queue_timeout: 0, rate_limited: 0, cancelled: 0, unavailable: 0 },
  wait: histogram(count), held: histogram(count, 0.5) });
const snapshot = (ids: string[], seconds = 10, count = 0): AvailableAdmissionSnapshot => ({ version: 1, available: true,
  monotonicSeconds: seconds, capacity: ids.length * 2, tenants: ids.map(id => tenant(id, count)) });
const body = (value: unknown) => Buffer.from(JSON.stringify(value));
const fixture = (): AdmissionInventory => ({ groups: [{ id: "ab", name: "A + B" }, { id: "c", name: "C isolated" }],
  tenants: [{ id: "tenantA", name: "Tenant A", groupId: "ab" }, { id: "tenantB", name: "Tenant B", groupId: "ab" }, { id: "tenantC", name: "Tenant C", groupId: "c" }],
  pools: [{ id: "pool-ab", name: "Shared A/B", groupId: "ab" }, { id: "pool-c", name: "Isolated C", groupId: "c" }],
  runners: [{ runnerId: "runner-ab", bootId: "boot-ab", controlSessionId: "session-ab", poolId: "pool-ab", status: "ready", disconnectedAt: null, sessionCurrent: true },
    { runnerId: "runner-c", bootId: "boot-c", controlSessionId: "session-c", poolId: "pool-c", status: "ready", disconnectedAt: null, sessionCurrent: true }] });

describe("Controller-authoritative diagnostic admission monitor", () => {
  let time: number, inventory: AdmissionInventory, monitor: TenantAdmissionMonitor;
  beforeEach(() => {
    time = 0; inventory = fixture();
    monitor = new TenantAdmissionMonitor({} as ControllerDatabase, { monotonicNow: () => time, wallNow: () => 1_700_000_000_000 + time,
      inventory: async poolId => {
        if (!poolId) return inventory;
        const pools = inventory.pools.filter(row => row.id === poolId), groups = new Set(pools.map(row => row.groupId));
        return { pools, groups: inventory.groups.filter(row => groups.has(row.id)), tenants: inventory.tenants.filter(row => groups.has(row.groupId)),
          runners: inventory.runners.filter(row => row.poolId === poolId) };
      } });
  });
  const record = (which: "ab" | "c", count = 0, seconds = 10, sequence = seconds) => {
    const runner = inventory.runners.find(row => row.runnerId === `runner-${which}`)!;
    monitor.record({ ...runner, sequence }, body(snapshot(which === "ab" ? ["tenantA", "tenantB"] : ["tenantC"], seconds, count)));
  };

  it("denies tenant callers before reading inventory", async () => {
    await expect(runWithTenantContext({ role: "user", tenantId: "tenantA" }, () => monitor.view())).rejects.toMatchObject({ status: 403 });
  });
  it("marks missing reports unavailable without inventing zero occupancy or latency", async () => {
    const result = await monitor.view();
    expect(result.available).toBe(false); expect(result.groups.every(row => row.values.active === null && row.values.waitP95Ms === null)).toBe(true);
    expect(admissionMonitorStateSchema.safeParse(result).success).toBe(true);
  });
  it("measures A/B shared placement and C isolation with valid histogram-delta estimates", async () => {
    record("ab"); record("c");
    const first = await monitor.view();
    expect(first.groups[0]).toMatchObject({ id: "ab", available: true, intervalAvailable: false,
      tenantIds: ["tenantA", "tenantB"], values: { active: 2, queued: 4, capacity: 4, occupancyPercent: 50, attemptsPerSecond: null, waitP95Ms: null } });
    time = 10_000; record("ab", 10, 20); record("c", 5, 20);
    const result = await monitor.view();
    expect(result.groups[0]).toMatchObject({ available: true, intervalAvailable: true, values: { attempts: 20, admitted: 20, admittedPerSecond: 2 } });
    expect(result.groups[0]!.values.waitP95Ms).toBeGreaterThan(50); expect(result.groups[0]!.values.waitP95Ms).toBeLessThanOrEqual(100);
    expect(result.groups[0]!.values.heldP95Ms).toBeGreaterThan(250); expect(result.groups[0]!.values.heldP95Ms).toBeLessThanOrEqual(500);
    expect(result.groups[1]!.values.admittedPerSecond).toBe(0.5);
    expect(result.tenants.find(row => row.id === "tenantA")!.values.admittedPerSecond).toBe(1);
    expect(admissionMonitorStateSchema.safeParse(result).success).toBe(true);
  });
  it("uses measured zero rates for an empty valid interval and gaps for empty or open-ended latency buckets", async () => {
    record("c"); time = 10_000; record("c", 0, 20);
    expect((await monitor.view("pool-c")).tenants[0]!.values).toMatchObject({ admittedPerSecond: 0, waitP95Ms: null, heldP95Ms: null });
    const runner = inventory.runners[1]!; const value = snapshot(["tenantC"], 30, 10);
    value.tenants[0]!.wait = histogram(10, 100); value.tenants[0]!.held = histogram(10, 100);
    time = 20_000; monitor.record({ ...runner, sequence: 30 }, body(value));
    expect((await monitor.view("pool-c")).tenants[0]!.values.waitP95Ms).toBeNull();
  });
  it.each(["session", "boot", "pool", "offline", "syncing", "stale"])("rejects %s source authority without retaining a live-looking value", async kind => {
    record("ab"); record("c"); await monitor.view();
    if (kind === "session") inventory.runners[0]!.controlSessionId = "replacement-session";
    if (kind === "boot") inventory.runners[0]!.bootId = "replacement-boot";
    if (kind === "pool") inventory.runners[0]!.poolId = "pool-c";
    if (kind === "offline") inventory.runners[0]!.status = "offline";
    if (kind === "syncing") inventory.runners[0]!.status = "syncing";
    if (kind === "stale") time = 30_001;
    const result = await monitor.view();
    expect(result.sources.find(row => row.runnerId === "runner-ab")!.available).toBe(false);
    expect(result.tenants.find(row => row.id === "tenantA")!.values.active).toBeNull();
  });
  it("checks every reported tenant against current DB group membership", async () => {
    const runner = inventory.runners[0]!;
    monitor.record({ ...runner, sequence: 1 }, body(snapshot(["tenantA", "foreign-private-label"])));
    const result = await monitor.view();
    expect(result.groups[0]).toMatchObject({ available: false, reason: "tenant_group_mismatch", values: { active: null } });
    expect(JSON.stringify(result)).not.toContain("foreign-private-label");
  });
  it("filters source pools and discards histories after placement or session changes", async () => {
    record("ab"); record("c"); await monitor.view(); time = 10_000; record("ab", 4, 20); record("c", 7, 20);
    const scoped = await monitor.view("pool-c");
    expect(scoped.groups.map(row => row.id)).toEqual(["c"]); expect(scoped.tenants.map(row => row.id)).toEqual(["tenantC"]);
    expect(scoped.sources.map(row => row.runnerId)).toEqual(["runner-c"]);
    expect(scoped.tenants[0]!.values.admitted).toBe(7);
    const before = await monitor.view(); expect(before.groups[0]!.history).toHaveLength(2);
    inventory.runners[0]!.controlSessionId = "replacement";
    expect((await monitor.view()).groups[0]!.history).toHaveLength(1);
  });
  it("treats counter resets and source replacement as unavailable intervals", async () => {
    record("ab", 10); time = 10_000; record("ab", 1, 20);
    expect((await monitor.view()).groups[0]).toMatchObject({ available: true, intervalAvailable: false, values: { active: 2, admittedPerSecond: null, waitP95Ms: null } });
    const runner = inventory.runners[0]!; runner.bootId = "new-boot"; runner.controlSessionId = "new-session";
    time = 20_000; record("ab", 100, 30);
    expect((await monitor.view()).groups[0]!.intervalAvailable).toBe(false);
  });
  it.each(["oversize", "malformed", "duplicate", "histogram", "foreign_fields", "disabled"])("fails closed for a %s report", async kind => {
    record("ab");
    const runner = inventory.runners[0]!, value = snapshot(["tenantA", "tenantB"]);
    let payload: Buffer;
    if (kind === "oversize") payload = Buffer.alloc(65_537, 32);
    else if (kind === "malformed") payload = Buffer.from("{invalid");
    else if (kind === "disabled") payload = body({ version: 1, available: false, reason: "disabled" });
    else {
      if (kind === "duplicate") value.tenants[1]!.tenantId = "tenantA";
      if (kind === "histogram") value.tenants[0]!.wait.buckets[0] = 1;
      payload = body(kind === "foreign_fields" ? { ...value, credential: "must-not-be-exposed" } : value);
    }
    monitor.record({ ...runner, sequence: 100 }, payload);
    const result = await monitor.view(); expect(result.groups[0]!.available).toBe(false);
    expect(result.groups[0]!.values.active).toBeNull(); expect(JSON.stringify(result)).not.toContain("must-not-be-exposed");
  });
  it("retains at most60 measured history points and refuses oversized inventory", async () => {
    for (let index = 0; index < 75; index += 1) { time = index * 10_000; record("ab", index, index + 1, index + 1); await monitor.view(); }
    expect((await monitor.view()).groups[0]!.history).toHaveLength(60);
    inventory.runners = Array.from({ length: 33 }, (_, index) => ({ ...fixture().runners[0]!, runnerId: `runner-${index}` }));
    expect(await monitor.view()).toMatchObject({ available: false, reason: "inventory_limit", groups: [], tenants: [] });
  });
});
