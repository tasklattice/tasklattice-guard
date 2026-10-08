import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeComplianceDocuments, analyzeGuardrailIntent, createValidationRun, resumeValidationRun, excludeGuardrailTestCase, getIntentAnalysisStatus, getValidationRuns, publishGuardrail, publishProgrammablePolicy, updateGuardrail } from "./api";
import { requestController } from "./controller-api";

describe("API error responses", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("does not let an empty detail object hide the Controller error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "Model timed out", detail: {} } }, { status: 504 })));
    await expect(requestController("/api/test")).rejects.toThrow("Model timed out");
  });

  it("preserves diagnostic details and upstream status separately from the Controller status", async () => {
    const detail = { provider: "NIM", upstreamStatus: 429, responseBody: "Quota exceeded" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "AI provider error", code: "intent_analysis_failed", detail } }, { status: 502 })));
    await expect(requestController("/api/test")).rejects.toMatchObject({ message: "AI provider error", status: 502, code: "intent_analysis_failed", detail });
  });

  it("shows a non-JSON proxy error rather than losing its response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream connection closed", { status: 502 })));
    await expect(requestController("/api/test")).rejects.toThrow("upstream connection closed");
  });
  it("pins Policy publication to the validated draft revision", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: "1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await publishProgrammablePolicy("policy-1", 7);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/policies/policy-1/publish", expect.objectContaining({
      method: "POST", body: JSON.stringify({ expectedDraftRevision: 7 }),
    }));
  });

  it("publishes exactly the reviewed Guardrail revision without refreshing its precondition", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Draft changed" } }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(publishGuardrail("guardrail-1", 7)).rejects.toThrow("Draft changed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/guardrails/guardrail-1/publish", expect.objectContaining({
      method: "POST", body: JSON.stringify({ expectedDraftRevision: 7 }),
    }));
  });

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

  it("creates, polls, and lists Test Runs using the new paths", async () => {
    vi.useFakeTimers();
    try {
      const run = { id: "run-1", guardrailId: "guard-1", status: "passed", metrics: {}, results: [], excludedCaseIds: [] };
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(Response.json({ ...run, status: "queued" }, { status: 202 }))
        .mockResolvedValueOnce(Response.json({ ...run, status: "running", progress: { phase: "executing", completedCases: 3, passedCases: 2 } }))
        .mockResolvedValueOnce(Response.json(run))
        .mockResolvedValueOnce(Response.json({ items: [run], count: 1 }));
      vi.stubGlobal("fetch", fetchMock);
      const onProgress = vi.fn();
      const pending = createValidationRun("guard-1", { onProgress });
      await vi.advanceTimersByTimeAsync(2000);
      expect((await pending).status).toBe("passed");
      expect(onProgress.mock.calls.map(([value]) => value.execution_status)).toEqual(["queued", "running", "passed"]);
      expect(onProgress.mock.calls[1]?.[0].progress).toMatchObject({ completedCases: 3, passedCases: 2 });
      expect((await getValidationRuns("guard-1")).count).toBe(1);
      expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
        "/api/v1/guardrails/guard-1/test-runs", "/api/v1/test-runs/run-1", "/api/v1/test-runs/run-1", "/api/v1/test-runs?guardrailId=guard-1",
      ]);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not turn a polling timeout into a failed report and can resume without another POST", async () => {
    vi.useFakeTimers();
    try {
      const run = { id: "run-slow", guardrailId: "guard-1", status: "running", metrics: { total: 10 }, results: [], excludedCaseIds: [] };
      const fetchMock = vi.fn().mockImplementation(async () => Response.json(run));
      vi.stubGlobal("fetch", fetchMock);
      const onProgress = vi.fn();
      const timedOut = expect(createValidationRun("guard-1", { onProgress })).rejects.toThrow("may still be running");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await timedOut;
      expect(onProgress.mock.lastCall?.[0].execution_status).toBe("running");
      fetchMock.mockImplementation(async () => Response.json({ ...run, status: "passed" }));
      expect((await resumeValidationRun("run-slow")).status).toBe("passed");
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends slash-containing Test Case IDs in the test-scope body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      url: "http://test/api/v1/guardrails/guardrail-1/test-scope",
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await excludeGuardrailTestCase(
      "guardrail-1",
      "library-policy/rule-acceptance",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/guardrails/guardrail-1/test-scope",
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
      deniedPurpose: "Medical advice and chemical process instructions",
      topicControlMode: "permissive",
      language: "en",
    })).resolves.toEqual(analysis);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/authoring/capabilities", {
      credentials: "same-origin",
      signal: expect.any(AbortSignal),
      headers: undefined,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/authoring/intent-analyses", {
      credentials: "same-origin",
      method: "POST",
      body: JSON.stringify({
        purpose: "Finance analysts use this assistant for approved reporting only.",
      deniedPurpose: "Medical advice and chemical process instructions",
      topicControlMode: "permissive",
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

});
