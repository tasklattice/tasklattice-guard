// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ControllerDatabase } from "../db/client.js";
import { TrafficRoutingService } from "./traffic-routing.js";

const target = { id: "target", guardrailId: "shared", guardrailVersion: "v1", weightBps: 10000 };
const router = { id: "router-b", tenantId: "tenantB", activeRevision: 1, activeSnapshot: { routes: [{
  id: "fallback", name: "Fallback", kind: "fallback", enabled: true,
  selector: { expression: { combinator: "and", conditions: [] } }, targets: [target],
}] } };
function service(results: unknown[][]) {
  const select = vi.fn(() => {
    const query: Record<string, unknown> = {};
    for (const method of ["from", "where", "innerJoin"]) query[method] = () => query;
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(resolve);
    return query;
  });
  return { select, routing: new TrafficRoutingService({ select } as unknown as ControllerDatabase) };
}
function results(shares: unknown[] = [{ resourceId: "shared", ownerTenantId: "tenantA", recipientTenantId: "tenantB" }]) {
  return [[router], [
    { id: "owned-b", routerId: "router-b", tenantId: "tenantB" },
    { id: "cross-owner-c", routerId: "router-b", tenantId: "tenantC" },
  ], [{ guardrailId: "shared", version: "v1", artifactId: "artifact", ownerTenantId: "tenantA" }], shares];
}
describe("allocated runtime Router snapshots", () => {
  it("does not query resources for an empty tenant group", async () => {
    const subject = service([]);
    expect(await subject.routing.runtimeSnapshots([])).toEqual([]);
    expect(subject.select).not.toHaveBeenCalled();
  });
  it("includes a currently shared target but never a cross-owner Endpoint binding", async () => {
    const { routing } = service(results());
    const snapshots = await routing.runtimeSnapshots(["tenantB", "tenantC"]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ routerId: "router-b", endpointIds: ["owned-b"] });
    expect(snapshots[0]!.routes[0]!.targets[0]).toMatchObject({ artifactId: "artifact" });
  });
  it.each([
    [],
    [{ resourceId: "shared", ownerTenantId: "old-owner", recipientTenantId: "tenantB" }],
    [{ resourceId: "shared", ownerTenantId: "tenantA", recipientTenantId: "tenantC" }],
  ].map(shares => ({ shares })))("removes the entire Router after a missing, stale-owner or wrong-recipient grant: %j", async ({ shares }) => {
    const { routing } = service(results(shares));
    expect(await routing.runtimeSnapshots(["tenantB", "tenantC"])).toEqual([]);
  });
  it("removes a Router whose pinned target no longer has an Artifact", async () => {
    const values = results();
    values[2] = [{ guardrailId: "shared", version: "v1", artifactId: null, ownerTenantId: "tenantA" }];
    expect(await service(values).routing.runtimeSnapshots(["tenantB"])).toEqual([]);
  });
});
