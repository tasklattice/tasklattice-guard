import { describe, expect, it, vi } from "vitest";
import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { ControlPlaneService } from "./control-plane.js";

function serviceWithSelectResults(results: unknown[][]) {
  const select = vi.fn(() => {
    const query: Record<string, unknown> = {};
    for (const method of ["from", "where", "innerJoin"]) query[method] = () => query;
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(resolve);
    return query;
  });
  return { select, service: new ControlPlaneService({ select } as unknown as ControllerDatabase, {} as ControllerConfig) };
}
const target = { guardrailId: "ordinary", guardrailVersion: "v1", weightBps: 10000 };
const route = { enabled: true, targets: [target] };

describe("Routed model requirements", () => {
  it.each([[], [{ snapshot: { routes: [{ ...route, enabled: false }] } }],
    [{ snapshot: { routes: [{ ...route, targets: [{ ...target, weightBps: 0 }] }] } }]].map(routers => ({ routers })))("requires no model for inactive routes %j", async ({ routers }) => {
    const { service, select } = serviceWithSelectResults([routers]);
    expect(await service.requiredPlatformModelBindings()).toEqual([]);
    expect(select).toHaveBeenCalledTimes(1);
  });
  it("deduplicates model bindings from routed immutable plans and preserves phases", async () => {
    const plan = { steps: [{ contract_ref: "tali.guard.content-safety.v1", phases: ["output"] }], policy_bindings: [] };
    const { service } = serviceWithSelectResults([[{ snapshot: { routes: [route] } }], [{ plan }, { plan }]]);
    expect(await service.requiredPlatformModelBindings()).toEqual(["content_safety.output"]);
  });
});
