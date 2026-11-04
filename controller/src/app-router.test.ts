import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { routeTree } from "./app-router";

function at(path: string) {
  return createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }), trailingSlash: "never" });
}

describe("Project navigation", () => {
  it.each([
    ["/test1", "/$projectId/", {}],
    ["/test1/playground", "/$projectId/playground", {}],
    ["/test1/guardrails", "/$projectId/guardrails", {}],
    ["/test1/guardrails/guardrail-123", "/$projectId/guardrails/$guardrailId", { guardrailId: "guardrail-123" }],
    ["/test1/policy-library", "/$projectId/policy-library", {}],
    ["/test1/integration/routers", "/$projectId/integration/routers", {}],
    ["/test1/integration/routers/router-123", "/$projectId/integration/routers/$routerId", { routerId: "router-123" }],
    ["/test1/integration/endpoints", "/$projectId/integration/endpoints", {}],
    ["/test1/logs", "/$projectId/logs", {}],
    ["/test1/billing", "/$projectId/billing", {}],
    ["/test1/sharing", "/$projectId/sharing", {}],
    ["/test1/settings/health", "/$projectId/settings/health", {}],
    ["/test1/settings/runner", "/$projectId/settings/runner", {}],
    ["/test1/settings/version", "/$projectId/settings/version", {}],
  ])("loads %s directly", async (path, routeId, params) => {
    const router = at(String(path)); await router.load();
    expect(router.state.matches.at(-1)?.routeId).toBe(routeId);
    expect(router.state.matches.at(-1)?.params).toEqual({ projectId: "test1", ...params });
    expect(router.state.matches.at(-1)?.status).toBe("success");
  });

  it("generates project links and restores filters and fragments through history", async () => {
    const router = at("/test2/guardrails/guardrail-123?tab=event&window=7d&pageSize=50&severity=high,critical,high,invalid#events");
    await router.load();
    expect(router.state.matches.at(-1)?.search).toMatchObject({ tab: "event", window: "7d", pageSize: 50, severity: "critical,high" });
    expect(router.buildLocation({ to: "/$projectId", params: { projectId: "test2" } }).href).toBe("/test2");
    expect(router.buildLocation({ to: "/$projectId/playground", params: { projectId: "test2" }, search: { guardrail: "guardrail-123" } }).href).toBe("/test2/playground?guardrail=guardrail-123");
    await router.navigate({ to: "/$projectId/guardrails/$guardrailId", params: { projectId: "test2", guardrailId: "guardrail-123" }, search: { tab: "event", window: "7d" } });
    expect(router.state.matches.at(-1)?.search.severity).toBeUndefined();
    router.history.back(); await router.load();
    expect(router.state.matches.at(-1)?.search.severity).toBe("critical,high");
    expect(router.state.location.hash).toBe("events");
  });

  it("restores Router tabs with Back/Forward and drops unsupported tabs", async () => {
    const router = at("/test1/integration/routers/router-123?tab=monitoring&routeId=partner"); await router.load();
    expect(router.state.matches.at(-1)?.search).toEqual({ tab: "monitoring", routeId: "partner" });
    await router.navigate({ to: "/$projectId/integration/routers/$routerId", params: { projectId: "test1", routerId: "router-123" }, search: { tab: "revisions", routeId: "partner" } });
    expect(router.history.location.href).toBe("/test1/integration/routers/router-123?tab=revisions&routeId=partner");
    router.history.back(); await router.load();
    expect(router.state.matches.at(-1)?.search.tab).toBe("monitoring");
    router.history.forward(); await router.load();
    expect(router.state.matches.at(-1)?.search.tab).toBe("revisions");
    await router.navigate({ to: "/$projectId/integration/routers/$routerId", params: { projectId: "test1", routerId: "router-123" }, search: { tab: "unknown" } });
    expect(router.state.matches.at(-1)?.search.tab).toBeUndefined();
  });

  it("preserves runtime metric deep links", async () => {
    const router = at("/test1/guardrails/guardrail-123?tab=runtime&window=1h&metric=request_rate#runtime-metrics"); await router.load();
    expect(router.state.matches.at(-1)?.search).toMatchObject({ tab: "runtime", window: "1h", metric: "request_rate" });
    expect(router.state.location.hash).toBe("runtime-metrics");
  });

  it("keeps billing filters in the selected project", async () => {
    const router = at("/test1/billing?guardrail=guardrail-123"); await router.load();
    expect(router.state.matches.at(-1)?.search).toEqual({ guardrail: "guardrail-123" });
    await router.navigate({ to: "/$projectId/billing", params: { projectId: "test2" }, search: { guardrail: "another" } });
    expect(router.history.location.href).toBe("/test2/billing?guardrail=another");
    router.history.back(); await router.load();
    expect(router.state.matches.at(-1)?.params.projectId).toBe("test1");
  });
});

describe("Global navigation", () => {
  it.each(["/account", "/account/security", "/account/access-tokens", "/access", "/access/projects", "/audit-log", "/settings/providers", "/settings/models", "/settings/guardrail-catalog", "/settings/health", "/settings/runner", "/settings/version"])("loads %s without a project", async path => {
    const router = at(path); await router.load();
    expect(router.state.matches.at(-1)?.routeId).toBe(path);
    expect(router.state.matches.at(-1)?.params).toEqual({});
    expect(router.state.matches.at(-1)?.status).toBe("success");
  });
  it("loads public documentation", async () => {
    const router = at("/document/operator/operator-create-policy#operator-policy-declarative"); await router.load();
    expect(router.state.matches.at(-1)?.routeId).toBe("/document/$categoryId/$articleId");
    expect(router.state.matches.at(-1)?.params).toEqual({ categoryId: "operator", articleId: "operator-create-policy" });
  });
});
