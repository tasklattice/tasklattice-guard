import { afterEach, describe, expect, it, vi } from "vitest";

import { getRouterTraces, getGuardrailFindings, getMetrics, getValidationRun, runtimeLogInteractions } from "./api";

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
      : { total_decisions: 0, fail_closed_count: 0 }), { status: 200, headers: { "content-type": "application/json" } })));
    const metrics = await getMetrics({ guardrailId: "local-bank" });
    expect(metrics.system_status).toBe("degraded");
    expect(metrics.system_reasons).toEqual(["runner_capacity_below_desired", "runner_configuration_syncing"]);
    expect(metrics.fail_closed_count).toBe(0);
  });
  it("preserves setup failure evidence in a mapped Validation Run", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "run", guardrailId: "guard", sourceDraftRevision: 1,
      status: "failed", failureReason: "No Evaluator Binding is available for content_safety.", metrics: {}, results: [], excludedCaseIds: [],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const run = await getValidationRun("run");
    expect(run.failure_reason).toBe("No Evaluator Binding is available for content_safety.");
    expect(run.status).toBe("failed");
    expect(run.results).toEqual([]);
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

  it("sends all selected levels to the server and excludes unmatched findings from mixed checkpoints", async () => {
    const fetchMock = vi.fn(async (path: string) => Response.json(path.startsWith('/api/v1/telemetry/metrics') ? {
      total_decisions: 2, findings_summary: { total: 3, critical: 1, high: 1, low: 1, affected_traces: 2 },
    } : { items: [{ ...event, metadata: { ...event.metadata, findings: ["high", "low"].map(riskSeverity => ({ ...event.metadata.findings[0], riskSeverity })) } }], nextCursor: "older" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await getGuardrailFindings("guardrail-1", "24h", 1, undefined, undefined, ["high", "critical"]);
    expect(new URL(String(fetchMock.mock.calls[0]![0]), "http://test").searchParams.get("severity")).toBe("critical,high");
    expect(result.items.map(item => item.severity)).toEqual(["high"]);
    expect(result.nextCursor).toBe("older");
    expect(result.summary.total).toBe(3);
  });

  it("marks legacy events as not collected instead of reporting a clean result", async () => {
    const legacy = { ...event, metadata: { protocol: "litellm", action: "allow" }, decision: "allow" };
    vi.stubGlobal("fetch", vi.fn(async (path: string) => new Response(JSON.stringify(path.startsWith('/api/v1/telemetry/metrics') ? {
      total_decisions: 1, data_availability: { execution_evidence: 'not_collected' },
      findings_summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0, affected_traces: 0, latest_at: null },
    } : { items: [legacy], count: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    const findings = await getGuardrailFindings("guardrail-1", "24h");

    expect(findings.items).toEqual([]);
    expect(findings.collection_status).toBe("not_collected");
  });
});
