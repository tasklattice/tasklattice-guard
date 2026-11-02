import { describe, expect, it, vi } from "vitest";
import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { ControlPlaneService } from "./control-plane.js";

// Every query in these paths ends in an awaited builder, so one thenable
// builder that pops the next scripted result keeps the fixtures compact.
function scriptedSelect(results: unknown[][]) {
  return vi.fn(() => {
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "where", "innerJoin", "leftJoin", "orderBy", "limit", "for"]) builder[method] = vi.fn(() => builder);
    builder.then = (resolve: (value: unknown) => void) => resolve(results.shift() ?? []);
    return builder;
  });
}

const config = { runnerToken: "runner-token-0123456789abcdef0123456789", deletionTrafficWindowMinutes: 5, offlineAfterSeconds: 60, telemetryStaleAfterSeconds: 120 } as unknown as ControllerConfig;
const artifact = (id: string) => ({ artifact: { id, guardrailId: `guardrail-${id}`, guardrailVersion: "v1" } });
const revision = {
  routerId: "router-1", revision: 2, endpointIds: ["endpoint-1"],
  routes: [{ id: "all", name: "All", kind: "fallback", enabled: true, selector: { expression: { combinator: "and", conditions: [] } },
    targets: [{ id: "t1", guardrailId: "guardrail-art-1", guardrailVersion: "v1", weightBps: 10000, artifactId: "art-1" }] }],
};

function desiredStateService(results: unknown[][], snapshots = [revision]) {
  const tx = { select: scriptedSelect(results), execute: vi.fn(async () => ({ rows: [] })) };
  const db = { transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)) } as unknown as ControllerDatabase;
  const service = new ControlPlaneService(db, config);
  Object.assign(service, { trafficRouting: { runtimeSnapshots: vi.fn(async () => snapshots) } });
  return service;
}

// Select order: pool allocation, controller state, group tenants, visible ready
// artifacts, disabled Guardrails, logging levels, disabled Endpoints, active Endpoints.
const desiredStateResults = () => [
  [{ groupId: "group-one" }],
  [{ desiredGeneration: 9 }],
  [{ id: "tenantA" }],
  [artifact("art-1"), artifact("art-2"), artifact("art-default")],
  [], [], [],
  [{ id: "endpoint-1", tenantId: "tenantA", trafficRouterId: "router-1", adapter: "litellm-generic-guardrail", verification: { credentials: [] } }],
] as unknown[][];

describe("desired state per pool", () => {
  it("distributes an explicit false Scan default", async () => {
    const results = desiredStateResults();
    results[7] = [{ id: "scan", adapter: "f5-scan", scanFlagOnlyDefault: false, verification: { credentials: [] } }];
    const desired = await desiredStateService(results).desiredStateForPool("default");
    expect(desired.endpoints[0]).toMatchObject({ endpointId: "scan", scanFlagOnlyDefault: false });
  });
  it("keeps visible ready versions for Playground in every pool of the assigned group", async () => {
    const service = desiredStateService(desiredStateResults());
    const desired = await service.desiredStateForPool("edge");
    expect(desired.generation).toBe(9);
    expect(desired.groupId).toBe("group-one");
    expect(service.trafficRouting.runtimeSnapshots).toHaveBeenCalledWith(["tenantA"], expect.anything());
    expect(desired.artifacts.map((item) => item.id).sort()).toEqual(["art-1", "art-2", "art-default"]);
    expect(desired).not.toHaveProperty("routers");
    expect(desired.routerRevisions).toEqual([expect.objectContaining({ routerId: "router-1", assignmentAlgorithm: "hmac-sha256-v1", assignmentKeyId: "v1" })]);
    expect(desired.routerRevisions[0]!.assignmentKey).toHaveLength(32);
    expect(desired.endpoints).toEqual([expect.objectContaining({ endpointId: "endpoint-1", tenantId: "tenantA", trafficRouterId: "router-1" })]);
  });

  it("uses the default pool's allocation rather than treating its name as global authority", async () => {
    const desired = await desiredStateService(desiredStateResults()).desiredStateForPool("default");
    expect(desired.artifacts.map((item) => item.id).sort()).toEqual(["art-1", "art-2", "art-default"]);
    expect(desired).not.toHaveProperty("routers");
  });

  it("rejects unknown or orphaned pools before reading any tenant resource", async () => {
    const service = desiredStateService([[]]);
    await expect(service.desiredStateForPool("unallocated")).rejects.toMatchObject({ code: "runner_pool_group_unavailable" });
    expect(service.trafficRouting.runtimeSnapshots).not.toHaveBeenCalled();
  });

  it("does not preserve an Endpoint binding absent from its permitted published snapshot", async () => {
    const results = desiredStateResults();
    results[7] = [
      { id: "endpoint-1", trafficRouterId: "router-1", adapter: "litellm-generic-guardrail", verification: {} },
      { id: "foreign-binding", trafficRouterId: "router-1", adapter: "litellm-generic-guardrail", verification: {} },
      { id: "draft-binding", trafficRouterId: "unpublished", adapter: "litellm-generic-guardrail", verification: {} },
    ];
    const desired = await desiredStateService(results).desiredStateForPool("edge");
    expect(desired.endpoints.map(endpoint => [endpoint.endpointId, endpoint.trafficRouterId])).toEqual([
      ["endpoint-1", "router-1"], ["foreign-binding", null], ["draft-binding", null],
    ]);
  });

  it("passes an empty tenant list explicitly instead of falling back to every tenant", async () => {
    const results = desiredStateResults();
    results[2] = [];
    results[3] = [];
    results[7] = [];
    const service = desiredStateService(results, []);
    const desired = await service.desiredStateForPool("empty-group-pool");
    expect(service.trafficRouting.runtimeSnapshots).toHaveBeenCalledWith([], expect.anything());
    expect(desired.artifacts).toEqual([]);
    expect(desired.routerRevisions).toEqual([]);
    expect(desired.endpoints).toEqual([]);
  });
});

describe("deletion impact from published Routers", () => {
  const snapshotFor = (guardrailId: string, tenantId = "tenantA") => ({ tenantId, activeSnapshot: { routes: [{ targets: [{ guardrailId }] }] } });
  const serviceWithPools = (results: unknown[][], poolsByTenant: Record<string, string[]>) => {
    const db = { select: scriptedSelect(results) } as unknown as ControllerDatabase;
    const service = new ControlPlaneService(db, config);
    const poolsForTenant = vi.fn(async (tenantId: string) => (poolsByTenant[tenantId] ?? []).map(id => ({ id })));
    Object.assign(service, { groupRouting: { poolsForTenant } });
    return { service, poolsForTenant };
  };
  const runner = (poolId: string, receivedAgoMs = 0) => ({ poolId, status: "ready", lastHeartbeatAt: new Date(), lastReceivedAt: new Date(Date.now() - receivedAgoMs) });

  it("counts Routers whose published revision targets the Guardrail", async () => {
    // Select order: Guardrail, published Routers, recent traffic, Runner telemetry.
    const { service } = serviceWithPools([
      [{ id: "guardrail-1" }],
      [snapshotFor("guardrail-1"), snapshotFor("guardrail-2"), snapshotFor("guardrail-1")],
      [{ requestCount: 0, lastRequestAt: null }],
      [],
    ], { tenantA: ["default"] });
    await expect(service.guardrailDeletionImpact("guardrail-1")).resolves.toMatchObject({
      resourceId: "guardrail-1", activeRouterCount: 2, requiresSecondConfirmation: false,
    });
  });

  it("reports an Endpoint as routed only when its bound Router is published", async () => {
    const bound = serviceWithPools([
      [{ id: "endpoint-1", tenantId: "tenantC", trafficRouterId: "router-1" }], [{ id: "router-1" }], [{ requestCount: 3, lastRequestAt: new Date() }], [runner("pool-c")],
    ], { tenantC: ["pool-c"] });
    await expect(bound.service.endpointDeletionImpact("endpoint-1")).resolves.toMatchObject({ activeRouterCount: 1, telemetryFresh: true, requiresSecondConfirmation: true });
    expect(bound.poolsForTenant).toHaveBeenCalledWith("tenantC");
    const unbound = serviceWithPools([[{ id: "endpoint-2", trafficRouterId: null }], [{ requestCount: 0, lastRequestAt: null }]], {});
    await expect(unbound.service.endpointDeletionImpact("endpoint-2")).resolves.toMatchObject({ activeRouterCount: 0, telemetryFresh: true });
    expect(unbound.poolsForTenant).not.toHaveBeenCalled();
  });

  it("requires fresh Runner telemetry from every pool of every referencing Router's tenant", async () => {
    const results = (telemetry: unknown[]) => [[{ id: "guardrail-1" }],
      [snapshotFor("guardrail-1", "tenantA"), snapshotFor("guardrail-1", "tenantC")],
      [{ requestCount: 4, lastRequestAt: new Date() }], telemetry];
    const pools = { tenantA: ["default", "pool-a"], tenantC: ["pool-c"] };
    const fresh = serviceWithPools(results([runner("default"), runner("pool-a"), runner("pool-c")]), pools);
    await expect(fresh.service.guardrailDeletionImpact("guardrail-1")).resolves.toMatchObject({ activeRouterCount: 2, telemetryFresh: true, incomingRequestCount: 4 });
    const missing = serviceWithPools(results([runner("default"), runner("pool-a")]), pools);
    await expect(missing.service.guardrailDeletionImpact("guardrail-1")).resolves.toMatchObject({ telemetryFresh: false, telemetryWatermark: null });
    const stale = serviceWithPools(results([runner("default"), runner("pool-a"), runner("pool-c", 180_000)]), pools);
    await expect(stale.service.guardrailDeletionImpact("guardrail-1")).resolves.toMatchObject({ telemetryFresh: false });
    const secondRunnerStale = serviceWithPools(results([runner("default"), runner("pool-a"), runner("pool-c"), runner("pool-c", 180_000)]), pools);
    await expect(secondRunnerStale.service.guardrailDeletionImpact("guardrail-1")).resolves.toMatchObject({ telemetryFresh: false });
    const absentMapping = serviceWithPools(results([runner("default"), runner("pool-a")]), { tenantA: ["default", "pool-a"], tenantC: [] });
    await expect(absentMapping.service.guardrailDeletionImpact("guardrail-1")).resolves.toMatchObject({ telemetryFresh: false });
  });
});
