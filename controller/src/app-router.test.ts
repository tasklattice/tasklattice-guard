import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { routeTree } from "./app-router";

// Use the actual application route tree so renamed links cannot silently 404.
describe("Integration navigation", () => {
  it.each([
    ["/integration/routers", "/integration/routers", {}],
    ["/integration/routers/router-123", "/integration/routers/$routerId", { routerId: "router-123" }],
    ["/integration/endpoint", "/integration/endpoint", {}],
  ])("resolves %s", async (path, routeId, params) => {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
    await router.load();
    expect(router.state.matches.at(-1)?.routeId).toBe(routeId);
    expect(router.state.matches.at(-1)?.params).toEqual(params);
    expect(router.state.matches.at(-1)?.status).toBe("success");
  });
});
