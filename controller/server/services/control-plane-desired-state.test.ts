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

function desiredStateService(results: unknown[][]) {
  const tx = { select: scriptedSelect(results) };
  const db = { transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)) } as unknown as ControllerDatabase;
  const service = new ControlPlaneService(db, config);
  Object.assign(service, { trafficRouting: { runtimeSnapshots: vi.fn(async () => [revision]) } });
  return service;
}

// Select order: controller state, the pinned baseline, baseline artifact,
// ready artifacts, disabled Guardrails, logging levels, disabled Endpoints,
// active Endpoints.
const desiredStateResults = () => [
  [{ desiredGeneration: 9 }],
  [{ baselineVersion: "v-default" }],
  [{ artifactId: "art-default" }],
  [artifact("art-1"), artifact("art-2"), artifact("art-default")],
  [], [], [],
  [{ id: "endpoint-1", trafficRouterId: "router-1", adapter: "litellm-generic-guardrail", verification: { credentials: [] } }],
] as unknown[][];

describe("desired state per pool", () => {
  it("ships only Router-referenced artifacts plus the Default Guardrail to non-default pools", async () => {
    const desired = await desiredStateService(desiredStateResults()).desiredStateForPool("edge");
    expect(desired.generation).toBe(9);
    expect(desired.artifacts.map((item) => item.id).sort()).toEqual(["art-1", "art-default"]);
    expect(desired).not.toHaveProperty("routers");
    expect(desired.routerRevisions).toEqual([expect.objectContaining({ routerId: "router-1", assignmentAlgorithm: "hmac-sha256-v1", assignmentKeyId: "v1" })]);
    expect(desired.routerRevisions[0]!.assignmentKey).toHaveLength(32);
    expect(desired.endpoints).toEqual([expect.objectContaining({ endpointId: "endpoint-1", trafficRouterId: "router-1" })]);
  });

  it("keeps every ready artifact available to the default pool for Playground", async () => {
    const desired = await desiredStateService(desiredStateResults()).desiredStateForPool("default");
    expect(desired.artifacts.map((item) => item.id).sort()).toEqual(["art-1", "art-2", "art-default"]);
    expect(desired).not.toHaveProperty("routers");
  });
});

describe("deletion impact from published Routers", () => {
  const snapshotFor = (guardrailId: string) => ({ activeSnapshot: { routes: [{ targets: [{ guardrailId }] }] } });

  it("counts Routers whose published revision targets the Guardrail", async () => {
    // Select order: Guardrail, published Routers, recent traffic, Runner telemetry.
    const db = { select: scriptedSelect([
      [{ id: "guardrail-1" }],
      [snapshotFor("guardrail-1"), snapshotFor("guardrail-2"), snapshotFor("guardrail-1")],
      [{ requestCount: 0, lastRequestAt: null }],
      [],
    ]) } as unknown as ControllerDatabase;
    await expect(new ControlPlaneService(db, config).guardrailDeletionImpact("guardrail-1")).resolves.toMatchObject({
      resourceId: "guardrail-1", activeRouterCount: 2, requiresSecondConfirmation: false,
    });
  });

  it("reports an Endpoint as routed only when its bound Router is published", async () => {
    const bound = { select: scriptedSelect([
      [{ id: "endpoint-1", trafficRouterId: "router-1" }], [{ id: "router-1" }], [{ requestCount: 3, lastRequestAt: new Date() }], [],
    ]) } as unknown as ControllerDatabase;
    await expect(new ControlPlaneService(bound, config).endpointDeletionImpact("endpoint-1")).resolves.toMatchObject({ activeRouterCount: 1, requiresSecondConfirmation: true });
    const unbound = { select: scriptedSelect([[{ id: "endpoint-2", trafficRouterId: null }], [{ requestCount: 0, lastRequestAt: null }]]) } as unknown as ControllerDatabase;
    await expect(new ControlPlaneService(unbound, config).endpointDeletionImpact("endpoint-2")).resolves.toMatchObject({ activeRouterCount: 0 });
  });
});
