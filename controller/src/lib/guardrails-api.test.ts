import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Guardrail } from "./controller-api";
import type { RouteTarget, TrafficRoute, TrafficRouter } from "./traffic-routing-api";
import { getGuardrails, guardrailTrafficVersions } from "./guardrails-api";

const api = vi.hoisted(() => ({ listControllerGuardrails: vi.fn(), listControllerRouters: vi.fn() }));
vi.mock("./controller-api", () => api);

const target = (version: string, weightBps = 10000, guardrailId = "g1"): RouteTarget =>
  ({ id: version, guardrailId, guardrailVersion: version, weightBps });
const route = (targets: RouteTarget[], enabled = true): TrafficRoute =>
  ({ id: "route", name: "Route", kind: "fallback", enabled, selector: { expression: { combinator: "and", conditions: [] } }, targets });
const router = (id: string, routes: TrafficRoute[], overrides: Partial<TrafficRouter> = {}): TrafficRouter => ({
  id, name: id, description: "", draftRevision: 2, draft: { routes: [route([target("draft-only")])] },
  activeRevision: 1, activeDraftRevision: 1, activeSnapshot: { routes }, desiredGeneration: 1,
  rolloutStatus: "active", endpointIds: ["endpoint"], updatedAt: "2026-10-10T00:00:00Z",
  pendingChangeRequest: null, revertibleChangeRequest: null, ...overrides,
});

describe("Guardrail resource summaries", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists every pinned traffic version and its routers, separately from baseline and draft", () => {
    const refs = guardrailTrafficVersions("g1", "20261009-090835.526Z", [
      router("A", [route([target("20261009-090835.526Z", 5000), target("20261009-090837.640Z", 5000)]), route([target("20261009-090835.526Z")])]),
      router("B", [route([target("20261009-090837.640Z")])], { rolloutStatus: "distributing" }),
      router("C", [route([target("20261009-090837.640Z")])], { rolloutStatus: "failed" }),
    ]);
    expect(refs).toEqual([
      { version: "20261009-090837.640Z", baseline: false, routers: [
        { id: "A", name: "A", status: "active" }, { id: "B", name: "B", status: "distributing" }, { id: "C", name: "C", status: "failed" },
      ] },
      { version: "20261009-090835.526Z", baseline: true, routers: [{ id: "A", name: "A", status: "active" }] },
    ]);
  });

  it("excludes unpublished or unbound routers, disabled routes, zero weights and other Guardrails", () => {
    const refs = guardrailTrafficVersions("g1", null, [
      router("unpublished", [route([target("v1")])], { activeRevision: null }),
      router("unbound", [route([target("v1")])], { endpointIds: [] }),
      router("no snapshot", [], { activeSnapshot: null }),
      router("ignored targets", [route([target("disabled")], false), route([target("zero", 0), target("other", 10000, "g2")])]),
    ]);
    expect(refs).toEqual([]);
  });

  it("uses evidence-derived readiness and retained-version counts, not cached lifecycle or draft testing", async () => {
    const base = { id: "g1", name: "Guardrail", status: "active", draftRevision: 2, draftConfig: {
      allowedTopics: [], restrictedTopics: [], policyBindings: [], safetyLevel: "balanced", outputDelivery: "window_buffered",
    }, hasUnpublishedChanges: true, readiness: "not_ready", versionSummary: { total: 2, released: 0, pending: 2, missingEvidence: 0 } } as Guardrail;
    api.listControllerGuardrails.mockResolvedValue({ items: [base, { ...base, id: "g2", readiness: "ready", status: "draft", versionSummary: { total: 3, released: 1, pending: 2, missingEvidence: 0 } }] });
    api.listControllerRouters.mockResolvedValue({ items: [] });
    const result = await getGuardrails();
    expect(result.items.map(item => ({ status: item.status, count: item.published_version_count, changes: item.has_unpublished_changes }))).toEqual([
      { status: "not_ready", count: 2, changes: true }, { status: "ready", count: 3, changes: true },
    ]);
  });
});
