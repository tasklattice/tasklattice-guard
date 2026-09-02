// @vitest-environment node
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { IntentAnalyzer } from "../control-plane-ai/intent-analyzer.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

const config = loadConfig({
  NODE_ENV: "test",
  CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
});

const analysis = {
  summary: "Finance analysis only.",
  structured_purpose: {
    audience: "Finance analysts",
    tasks: "Approved reporting only",
    protect: "Internal finance datasets and reporting limits",
    out_of_scope: "Medical or chemical-process advice",
  },
  allowed_topics: ["Financial analysis", "Financial reporting"],
  restricted_topics: ["Medical advice", "Chemical process instructions"],
  review_notes: [],
};

describe("Intent analysis HTTP API", () => {
  it("reports the configured authoring model with document analysis", async () => {
    const analyzer = fakeAnalyzer();
    const response = await appWith({ user: { id: "member-1", role: "user" } }, analyzer)
      .request("/api/v1/intent-analysis-status");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      available: true,
      provider: "DeepSeek",
      model: "deepseek-test",
      document_analysis_available: true,
    });
  });

  it("converts an administrator's business purpose into editable Topic rules", async () => {
    const analyzer = fakeAnalyzer();
    const response = await appWith({ user: { id: "admin-1", role: "admin" } }, analyzer)
      .request("/api/v1/intent-analyses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          purpose: "Finance analysts use this assistant for approved reporting only.",
          language: "en",
        }),
      });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(analysis);
    expect(analyzer.analyze).toHaveBeenCalledWith({
      purpose: "Finance analysts use this assistant for approved reporting only.",
      language: "en",
    });
  });

  it("extracts uploaded compliance text and returns source-linked requirements", async () => {
    const analyzer = fakeAnalyzer();
    const boundary = "tasklattice-test-boundary";
    const form = [
      `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="privacy.txt"\r\nContent-Type: text/plain\r\n\r\n`,
      "Privacy standard\nAccount identifiers must be redacted before any model request.\n\r\n",
      `--${boundary}--\r\n`,
    ].join("");
    const response = await appWith({ user: { id: "admin-1", role: "admin" } }, analyzer)
      .request("/api/v1/compliance-document-analyses", {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body: form,
      });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: "Privacy requirements.",
      requirements: [{ source_refs: ["document-1:lines-1-2"] }],
      sources: [{ id: "document-1", name: "privacy.txt", format: "txt" }],
    });
    expect(analyzer.analyzeDocuments).toHaveBeenCalledWith(expect.objectContaining({
      language: "en",
      documents: [expect.objectContaining({ id: "document-1" })],
    }));
  });

  it("returns an explicit unavailable response when no authoring model is configured", async () => {
    const app = appWith({ user: { id: "admin-1", role: "admin" } }, null);
    const status = await app.request("/api/v1/intent-analysis-status");
    const analysisResponse = await app.request("/api/v1/intent-analyses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose: "A sufficiently detailed business purpose for analysis.", language: "en" }),
    });

    await expect(status.json()).resolves.toMatchObject({ available: false });
    expect(analysisResponse.status).toBe(503);
    await expect(analysisResponse.json()).resolves.toMatchObject({ error: { code: "intent_analysis_unavailable" } });
  });

  it("does not let a non-administrator spend authoring-model tokens", async () => {
    const analyzer = fakeAnalyzer();
    const response = await appWith({ user: { id: "member-1", role: "user" } }, analyzer)
      .request("/api/v1/intent-analyses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ purpose: "A sufficiently detailed business purpose for analysis.", language: "en" }),
      });

    expect(response.status).toBe(403);
    expect(analyzer.analyze).not.toHaveBeenCalled();
  });
});

function fakeAnalyzer(): IntentAnalyzer {
  return {
    provider: "DeepSeek",
    model: "deepseek-test",
    analyze: vi.fn().mockResolvedValue(analysis),
    analyzeDocuments: vi.fn().mockResolvedValue({
      summary: "Privacy requirements.",
      allowed_topics: [],
      restricted_topics: [],
      requirements: [{
        title: "Redact identifiers",
        description: "Identifiers must be redacted.",
        effect: "transform",
        source_refs: ["document-1:lines-1-2"],
      }],
      recommended_policy_ids: [],
      review_notes: [],
    }),
  };
}

function appWith(
  session: { user: { id: string; role: string } } | null,
  intentAnalyzer: IntentAnalyzer | null,
) {
  const auth = {
    api: { getSession: vi.fn().mockResolvedValue(session) },
    handler: vi.fn(),
  } as unknown as ControllerAuth;
  return createHttpApp({
    config,
    auth,
    service: { listPolicies: vi.fn().mockResolvedValue([]) } as unknown as ControlPlaneService,
    runnerControl: {} as RunnerControlServer,
    metrics: {} as ControllerMetrics,
    intentAnalyzer,
  });
}
