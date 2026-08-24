import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeComplianceDocuments, analyzeGuardrailIntent, excludeGuardrailTestCase, getDeploymentDeletionImpact, getIntentAnalysisStatus, updateGuardrail } from "./api";

describe("API error responses", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders FastAPI validation issues as readable field messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      status: 422,
      ok: false,
      url: "http://test/api/v1/guardrails/guardrail-1",
      json: async () => ({
        detail: [
          { loc: ["body", "policy_bindings", 0, "parameter_values"], msg: "Input should be a valid dictionary" },
          { loc: ["body", "policy_bindings", 0, "rule_actions"], msg: "Input should be a valid dictionary" },
        ],
      }),
    }));

    await expect(updateGuardrail("guardrail-1", { name: "Banker" })).rejects.toThrow(
      "policy_bindings.0.parameter_values: Input should be a valid dictionary; "
      + "policy_bindings.0.rule_actions: Input should be a valid dictionary",
    );
  });

  it("sends slash-containing Test Case IDs in the validation-scope body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      url: "http://test/api/v1/guardrails/guardrail-1/validation-scope",
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await excludeGuardrailTestCase(
      "guardrail-1",
      "library-policy/rule-acceptance",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/guardrails/guardrail-1/validation-scope",
      {
        credentials: "same-origin",
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caseId: "library-policy/rule-acceptance",
          excluded: true,
        }),
      },
    );
  });

  it("uses the restored Controller intent-analysis endpoints", async () => {
    const status = {
      available: true,
      provider: "DeepSeek",
      model: "deepseek-test",
      document_analysis_available: false,
    };
    const analysis = {
      summary: "Finance analysis only.",
      allowed_topics: ["Financial analysis", "Financial reporting"],
      restricted_topics: ["Medical advice", "Chemical processes"],
      review_notes: [],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(status), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(analysis), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getIntentAnalysisStatus()).resolves.toEqual(status);
    await expect(analyzeGuardrailIntent({
      purpose: "Finance analysts use this assistant for approved reporting only.",
      language: "en",
    })).resolves.toEqual(analysis);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/intent-analysis-status", {
      credentials: "same-origin",
      headers: undefined,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/intent-analyses", {
      credentials: "same-origin",
      method: "POST",
      body: JSON.stringify({
        purpose: "Finance analysts use this assistant for approved reporting only.",
        language: "en",
      }),
      headers: { "content-type": "application/json" },
    });
  });

  it("lets the browser set the multipart boundary for document uploads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ requirements: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const file = new File(["policy text"], "policy.txt", { type: "text/plain" });
    await analyzeComplianceDocuments([file], "en");

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.body).toBeInstanceOf(FormData);
    expect(request.headers).toBeUndefined();
  });

  it("turns an outdated Controller deletion-impact response into a recoverable error", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith("/deletion-impact")) return new Response(JSON.stringify({}), { status: 200 });
      if (path.endsWith("/deployments")) return new Response(JSON.stringify({ items: [{
        id: "deployment-1",
        name: "Regional traffic",
        guardrailId: "guardrail-1",
        integrationId: "integration-1",
        poolId: "default",
        guardrailVersion: 1,
        routeOrder: 0,
        enabled: true,
        trafficScope: { combinator: "and", conditions: [] },
        createdAt: "2026-08-24T08:00:00.000Z",
        updatedAt: "2026-08-24T08:00:00.000Z",
      }] }), { status: 200 });
      return new Response(JSON.stringify({ items: [{
        id: "guardrail-1",
        activeVersion: 1,
      }] }), { status: 200 });
    }));

    await expect(getDeploymentDeletionImpact("deployment-1")).rejects.toThrow(
      "Deployment deletion impact is unavailable",
    );
  });
});
