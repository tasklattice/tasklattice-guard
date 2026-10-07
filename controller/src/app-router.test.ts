import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { routeTree } from "./app-router";

// Use the actual application route tree so renamed links cannot silently 404.
describe("Integration navigation", () => {
  it("restores canonical event filters from shareable URLs and browser history", async () => {
    const history = createMemoryHistory({ initialEntries: ["/guardrails/guardrail-default?tab=event&window=7d&severity=high,critical,high,invalid"] });
    const router = createRouter({ routeTree, history });
    await router.load();
    expect(router.state.matches.at(-1)?.search).toMatchObject({ tab: "event", window: "7d", severity: "critical,high" });
    await router.navigate({ to: "/guardrails/$guardrailId", params: { guardrailId: "guardrail-default" }, search: { tab: "event", window: "7d" } });
    expect(router.state.matches.at(-1)?.search.severity).toBeUndefined();
    history.back();
    await router.load();
    expect(router.state.matches.at(-1)?.search.severity).toBe("critical,high");
  });

  it("restores Router tabs through back/forward history and rejects unknown tabs", async () => {
    const history = createMemoryHistory({ initialEntries: ["/integration/routers/router-123?tab=monitoring&routeId=partner"] });
    const router = createRouter({ routeTree, history });
    await router.load();
    expect(router.state.matches.at(-1)?.search).toEqual({ tab: "monitoring", routeId: "partner" });
    await router.navigate({ to: "/integration/routers/$routerId", params: { routerId: "router-123" }, search: { tab: "revisions", routeId: "partner" } });
    expect(history.location.search).toContain("tab=revisions");
    history.back();
    await router.load();
    expect(router.state.matches.at(-1)?.search.tab).toBe("monitoring");
    history.forward();
    await router.load();
    expect(router.state.matches.at(-1)?.search.tab).toBe("revisions");
    await router.navigate({ to: "/integration/routers/$routerId", params: { routerId: "router-123" }, search: { tab: "unknown" } });
    expect(router.state.matches.at(-1)?.search.tab).toBeUndefined();
  });

  it.each([["event", "event"], ["findings", undefined], ["testing", "testing"], ["validation", undefined]])("handles Guardrail tab %s without a legacy alias", async (tab, expected) => {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [`/guardrails/guardrail-default?tab=${tab}`] }) });
    await router.load();
    expect(router.state.matches.at(-1)?.routeId).toBe("/guardrails/$guardrailId");
    expect(router.state.matches.at(-1)?.search.tab).toBe(expected);
  });

  it.each([
    ["/account", "/account", {}],
    ["/account/security", "/account/security", {}],
    ["/account/access-tokens", "/account/access-tokens", {}],
    ["/integration/routers", "/integration/routers", {}],
    ["/integration/routers/router-123", "/integration/routers/$routerId", { routerId: "router-123" }],
    ["/integration/endpoints", "/integration/endpoints", {}],
    ["/document/overview/quickstart-protection", "/document/$categoryId/$articleId", { categoryId: "overview", articleId: "quickstart-protection" }],
    ["/document/operator/operator-create-policy#operator-policy-declarative", "/document/$categoryId/$articleId", { categoryId: "operator", articleId: "operator-create-policy" }],
  ])("resolves %s", async (path, routeId, params) => {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
    await router.load();
    expect(router.state.matches.at(-1)?.routeId).toBe(routeId);
    expect(router.state.matches.at(-1)?.params).toEqual(params);
    expect(router.state.matches.at(-1)?.status).toBe("success");
  });
});
