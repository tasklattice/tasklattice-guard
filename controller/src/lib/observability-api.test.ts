import { afterEach, describe, expect, it, vi } from "vitest";

import { getDeploymentTraces, getGuardrailFindings } from "./api";

const event = {
  id: "event-1",
  occurredAt: "2026-08-20T10:00:00.000Z",
  requestId: "request-1",
  runnerId: "runner-1",
  guardrailId: "guardrail-1",
  guardrailVersion: "20260904-030000.003Z",
  integrationId: "integration-1",
  deploymentId: "deployment-1",
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

  it("maps Runner findings and execution steps without inventing protected content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [event], count: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const traces = await getDeploymentTraces("deployment-1");

    expect(fetchMock.mock.calls[0]?.[0]).toContain("deploymentId=deployment-1");
    expect(traces.items[0]).toMatchObject({
      evidence_status: "collected",
      runtime_engine: "llmrails",
      config_checksum: "checksum-1",
      findings: [{ policy_id: "builtin-secrets", rule_id: "credential-pattern", severity: "high" }],
      steps: [{ action_name: "GuardSecretsAction", latency_ms: 7 }],
    });
    expect(JSON.stringify(traces)).not.toContain("sensitive prompt fragment");
  });

  it("marks legacy events as not collected instead of reporting a clean result", async () => {
    const legacy = { ...event, metadata: { protocol: "litellm", action: "allow" }, decision: "allow" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [legacy], count: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    const findings = await getGuardrailFindings("guardrail-1", "24h");

    expect(findings.items).toEqual([]);
    expect(findings.collection_status).toBe("not_collected");
  });
});
