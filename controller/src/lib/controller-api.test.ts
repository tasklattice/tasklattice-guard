import { afterEach, describe, expect, it, vi } from "vitest";
import { getModelConfiguration, requestController } from "./controller-api";
import { capabilityBindingIds } from "../../shared/guardrail-catalog";
import { setCurrentProjectId } from "./project-context";

afterEach(() => { setCurrentProjectId(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("rejects a legacy-only backend view that would hide the effective review assignments", async () => {
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({draft:{assignments:{bindings:{"classifier_review.input":"review"}}}})));
  await expect(getModelConfiguration()).rejects.toThrow("Deploy the matching Controller backend");
});

it("accepts a view with explicit per-capability assignments, including disabled reviewers", async () => {
  const bindings = Object.fromEntries(capabilityBindingIds.map(id => [id,null]));
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({draft:{assignments:{controlPlane:null,bindings}}})));
  expect((await getModelConfiguration()).draft?.assignments.bindings).toEqual(bindings);
});

describe("Controller authorization recovery", () => {
  it("guards project-scoped account writes against another tab changing projects", async () => {
    setCurrentProjectId("project-a");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({error: {code: "project_changed", message: "Refresh before continuing"}}), {status: 409}));
    vi.stubGlobal("fetch", fetch);
    const dispatch = vi.spyOn(window, "dispatchEvent");
    await expect(requestController("/api/v1/guardrails", {method: "POST", body: "{}"})).rejects.toThrow("Refresh before continuing");
    expect((fetch.mock.calls[0]![1].headers as Headers).get("x-project-id")).toBe("project-a");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls.some(([event]) => event.type === "tasklattice:unauthorized")).toBe(true);
  });
  it.each([401, 403, 500])("preserves HTTP %s errors without replaying writes", async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Rejected write" } }), { status }));
    vi.stubGlobal("fetch", fetch);
    const dispatch = vi.spyOn(window, "dispatchEvent");
    await expect(requestController("/api/v1/guardrails", { method: "POST", body: "{}" })).rejects.toThrow("Rejected write");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls.filter(([event]) => event.type === "tasklattice:unauthorized")).toHaveLength(status === 500 ? 0 : 1);
  });
});
