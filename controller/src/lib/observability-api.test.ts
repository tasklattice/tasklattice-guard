import { afterEach, describe, expect, it, vi } from "vitest";

import { getRouterTraces, getGuardrailFindings, getMetrics, getValidationRun, runtimeLogInteractions } from "./api";
import { assembleMetrics } from "../../server/services/runtime-metric-results";

const emptyMetrics = () => assembleMetrics({ window: "24h" }, Date.parse("2026-10-09T07:00:00Z"), 900_000, "15m", [], [], [], [], [], []);

const event = {
  id: "event-1",
  occurredAt: "2026-08-20T10:00:00.000Z",
  requestId: "request-1",
  runnerId: "runner-1",
  guardrailId: "guardrail-1",
  guardrailVersion: "20260904-030000.003Z",
  endpointId: "endpoint-1",
  routerId: "router-1",
  direction: "incoming",
  decision: "block",
  durationMs: 19,
  metadata: {
    captureLevel: "info",
    protocol: "litellm",
    action: "block",
    findings: [{
      id: "finding-1",
      risk: "secrets",
      verdict: "matched",
      confidence: 0.98,
      riskSeverity: "high",
      policyVersion: "1",
      evidence: "sensitive prompt fragment",
      recommendedAction: "block",
      policyId: "builtin-secrets",
      ruleId: "credential-pattern",
    }],
    trace: [{
      id: "step-1",
      kind: "action",
      parentId: "root-span",
      name: "Secrets detector",
      outcome: "matched",
      durationMs: 7,
      actionName: "GuardSecretsAction",
      actionVersion: "1.0.0",
    }],
    usage: { runtime_engine: "llmrails", config_checksum: "checksum-1" },
  },
};

describe("privacy-safe runtime observability", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retains an execution failure separately from the three enforcement outcomes", () => {
    const [interaction] = runtimeLogInteractions([
      { ...event, decision: "block", metadata: { executionStatus: "error", runtimeLogCaptured: true } },
      { ...event, id: "no-decision", decision: "error", metadata: { runtimeLogCaptured: true } },
    ]);
    expect(interaction.outcome).toBe("block");
    expect(interaction.entries.map(entry => [entry.outcome, entry.execution_status])).toEqual([["block", "error"], [null, "error"]]);
  });

  it("finds fail-closed trace errors with diagnostics while preserving the enforcement outcome", () => {
    const [interaction] = runtimeLogInteractions([{ ...event, metadata: { trace: [{ id: "failed-span", name: "Judge", outcome: "error", errorType: "AuthenticationError", providerName: "openai", modelName: "judge-model", policyId: "safety" }] } }], { outcome: "error", includeUncaptured: true });
    expect(interaction.entries[0]).toMatchObject({ outcome: "block", execution_status: "error", error_details: [{ span_id: "failed-span", error_type: "AuthenticationError", provider: "openai", model: "judge-model", policy: "safety" }] });
    expect(runtimeLogInteractions([event], { outcome: "error", includeUncaptured: true })).toEqual([]);
  });

  it("maps inferred call completion independently of input/output checks", () => {
    const [interaction] = runtimeLogInteractions([{ ...event, direction: "completion", decision: "timeout", durationMs: 300000, metadata: { logKind: "call_completion", completionInferred: true, decisionId: "decision-1", completedAt: "2026-08-20T10:05:00.000Z", routerRevision: 2 } }], { outcome: "error", includeUncaptured: true });
    expect(interaction.entries[0]).toMatchObject({ phase: "completion", outcome: null, execution_status: "error", call_completion: { inferred: true, decision_id: "decision-1", completed_at: "2026-08-20T10:05:00.000Z", router_revision: 2, reason: null } });
  });

  it("does not invent an allow outcome when no enforcement decision was reported", () => {
    const [interaction] = runtimeLogInteractions([{ ...event, guardrailId: null, decision: "timeout", metadata: {} }], { includeUncaptured: true });
    expect(interaction.guardrail_id).toBeNull();
    expect(interaction.outcome).toBeNull();
    expect(interaction.entries[0]).toMatchObject({ outcome: null, execution_status: "error", timed_out: true });
  });

  it("keeps platform readiness reasons distinct from scoped Guardrail evidence", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string) => new Response(JSON.stringify(path === "/api/v1/system/status"
      ? { status: "degraded", reasons: ["runner_capacity_below_desired", "runner_configuration_syncing"] }
      : emptyMetrics()), { status: 200, headers: { "content-type": "application/json" } })));
    const metrics = await getMetrics({ guardrailId: "local-bank" });
    expect(metrics.system_status).toBe("degraded");
    expect(metrics.system_reasons).toEqual(["runner_capacity_below_desired", "runner_configuration_syncing"]);
    expect(metrics.fail_closed_count).toBe(0);
  });

  it.each([
    ["collection response", { items: [], count: 0 }],
    ["null response", null],
    ["missing total", { ...emptyMetrics(), total_decisions: undefined }],
    ["missing latency", { ...emptyMetrics(), total_decisions: 1, runtime_p95_ms: undefined }],
    ["missing rate", { ...emptyMetrics(), total_decisions: 1, intervention_rate: undefined }],
    ["string count", { ...emptyMetrics(), total_decisions: "0" }],
    ["missing comparison", { ...emptyMetrics(), comparison: {} }],
    ["missing SLO", { ...emptyMetrics(), latency_slo: null }],
    ["missing trend", { ...emptyMetrics(), trend_series: {} }],
    ["invalid trend point", { ...emptyMetrics(), trend_series: { none: [{ name: "All traffic", points: [null] }] } }],
  ])("rejects %s instead of passing an invalid snapshot to the Dashboard", async (_name, payload) => {
    vi.stubGlobal("fetch", vi.fn(async (path: string) => Response.json(path === "/api/v1/system/status"
      ? { status: "healthy", reasons: [] } : payload)));
    await expect(getMetrics()).rejects.toThrow("Runtime metrics are unavailable or incomplete");
  });

  it("preserves complete telemetry, including nullable comparisons and trend points", async () => {
    const payload = assembleMetrics({ window: "24h" }, Date.parse("2026-10-09T07:00:00Z"), 900_000, "15m",
      [{ kind: "period", key: "current", total: 100, allowed: 80, blocked: 15, intervened: 5, latency: [10, 20, 30] }], [], [], [], [], []);
    vi.stubGlobal("fetch", vi.fn(async (path: string) => Response.json(path === "/api/v1/system/status"
      ? { status: "healthy", reasons: [] } : payload)));
    expect(await getMetrics()).toEqual({ ...payload, system_status: "healthy", system_reasons: [] });
  });
  it("preserves setup failure evidence in a mapped Validation Run", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "run", guardrailId: "guard", sourceDraftRevision: 1,
      status: "failed", failureReason: "No Evaluator Binding is available for content_safety.", metrics: {}, results: [], excludedCaseIds: [],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const run = await getValidationRun("run");
    expect(run.failure_reason).toBe("No Evaluator Binding is available for content_safety.");
    expect(run.status).toBe("failed");
    expect(run).not.toHaveProperty("results");
  });

  it("maps Runner findings and execution steps without inventing protected content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [event], count: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const traces = await getRouterTraces("router-1");

    expect(fetchMock.mock.calls[0]?.[0]).toContain("routerId=router-1");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("limit=100");
    expect(traces.items[0]).toMatchObject({
      evidence_status: "collected",
      runtime_engine: "llmrails",
      config_checksum: "checksum-1",
      findings: [{ policy_id: "builtin-secrets", rule_id: "credential-pattern", severity: "high" }],
      steps: [{ action_name: "GuardSecretsAction", latency_ms: 7, parent_id: "root-span" }],
    });
    expect(JSON.stringify(traces)).not.toContain("sensitive prompt fragment");
  });

  it("requests one page of individual findings without requesting statistics", async () => {
    const record = { eventId: event.id, findingIndex: 45, occurredAt: event.occurredAt, requestId: event.requestId,
      guardrailId: event.guardrailId, guardrailVersion: event.guardrailVersion, routerId: event.routerId,
      endpointId: event.endpointId, direction: event.direction, decision: event.decision, protocol: "playground", action: "block",
      finding: { ...event.metadata.findings[0], riskSeverity: "high" } };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ items: [record], count: 1, nextCursor: "older", since: "start", until: "end" }));
    vi.stubGlobal("fetch", fetchMock);
    const until = "2026-10-15T08:00:00.000Z";
    const result = await getGuardrailFindings("guardrail-1", "24h", 50, "previous", undefined, ["high", "critical"], until);
    const url = new URL(String(fetchMock.mock.calls[0]![0]), "http://test");
    expect(url.pathname).toBe("/api/v1/telemetry/security-events");
    expect(Object.fromEntries(url.searchParams)).toEqual({ guardrailId: "guardrail-1", window: "24h", limit: "50", cursor: "previous", severity: "critical,high", until });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.items[0]).toMatchObject({ id: `${event.id}:finding:45`, event_id: event.id, severity: "high" });
    expect(result.nextCursor).toBe("older");
    expect(result).not.toHaveProperty("summary");
  });

  it("defaults to 25 findings and propagates cancellation", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ items: [], count: 0, nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await getGuardrailFindings("guardrail-1", "7d", undefined, undefined, controller.signal);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("limit=25");
    controller.abort();
    expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(result.items).toEqual([]);
  });

});

it("preserves the mode and real detector result separately from allowed traffic", () => {
  const monitor = runtimeLogInteractions([{ ...event, decision: "allow", metadata: { protectionMode: "monitor", detectionDecision: "block", executionStatus: "complete" } }], { includeUncaptured: true })[0].entries[0];
  expect(monitor).toMatchObject({ outcome: "allow", protection_mode: "monitor", detection_decision: "block", detection_error: null });
  const bypass = runtimeLogInteractions([{ ...event, decision: "allow", metadata: { protectionMode: "bypass", executionStatus: "bypassed" } }], { includeUncaptured: true })[0].entries[0];
  expect(bypass).toMatchObject({ outcome: "allow", protection_mode: "bypass", findings: [], detection_decision: null });
});
