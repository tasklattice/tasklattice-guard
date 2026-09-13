import { afterEach, describe, expect, it, vi } from "vitest";

import { getRouterTraces, getGuardrailFindings, getMetrics, getValidationRun } from "./api";

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
    action: "reject",
    findings: [{
      id: "finding-1",
      risk: "secrets",
      verdict: "unsafe",
      confidence: 0.98,
      evidence: "sensitive prompt fragment",
      recommendedAction: "reject",
      policyId: "builtin-secrets",
      ruleId: "credential-pattern",
    }],
    trace: [{
      id: "step-1",
      kind: "action",
      parentId: "root-span",
      name: "Secrets detector",
      outcome: "unsafe",
      durationMs: 7,
      actionName: "GuardSecretsAction",
      actionVersion: "1.0.0",
    }],
    usage: { runtime_engine: "llmrails", config_checksum: "checksum-1" },
  },
};

describe("privacy-safe runtime observability", () => {
  afterEach(() => vi.unstubAllGlobals());

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
