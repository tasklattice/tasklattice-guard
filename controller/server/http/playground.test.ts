import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import { OpenAICompatiblePlaygroundModel, RunnerPlaygroundClient } from "../playground/service.js";
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

describe("Guardrail Playground HTTP capability", () => {
  it("prepares and runs an administrator-only draft preview without an immutable version", async () => {
    const versionId = "20260904-073000.123Z";
    const modelFetch = vi.fn(async () => Response.json({ choices: [{ message: { content: "draft answer" } }] })) as typeof fetch;
    const runnerFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${config.runnerToken}` });
      if (!path.endsWith("/evaluate")) {
        expect(request).toMatchObject({
          guardrail_id: "guardrail-draft",
          draft_revision: 7,
          candidate_version: versionId,
          runtime_profile: "auto",
        });
        return Response.json({
          draft_revision: 7,
          compiler_version: "runner-preview-v1",
          runtime_profile: "llmrails_colang1_standard",
          ttl_seconds: 900,
        });
      }
      expect(request).toMatchObject({
        draft_revision: 7,
        candidate_version: versionId,
        protocol: "playground",
      });
      expect(request).not.toHaveProperty("guardrail_version");
      return Response.json({
        decision: "allow",
        action: "pass",
        reason: "draft passed",
        texts: [],
        guardrail_id: "guardrail-draft",
        guardrail_version: versionId,
        findings: [],
        trace: [],
        usage: { runtime_engine: "llmrails", runtime_profile: "llmrails_colang1_standard" },
      });
    }) as typeof fetch;
    const service = {
      playgroundDraftCandidate: vi.fn().mockResolvedValue({
        guardrailId: "guardrail-draft",
        guardrailName: "Draft Guardrail",
        draftRevision: 7,
        candidateVersion: versionId,
        runtimeProfile: "auto",
        compilerVersion: "controller-plan-v2",
        plan: { guardrail_id: "guardrail-draft", guardrail_version: versionId, compiler_version: "controller-plan-v2", steps: [], modules: [] },
      }),
      getGuardrail: vi.fn().mockResolvedValue({ id: "guardrail-draft", draftRevision: 7 }),
    } as unknown as ControlPlaneService;
    const app = createHttpApp({
      config,
      auth: {
        api: { getSession: vi.fn().mockResolvedValue({ user: { id: "admin-1", role: "admin" } }) },
        handler: vi.fn(),
      } as unknown as ControllerAuth,
      service,
      runnerControl: {} as RunnerControlServer,
      metrics: {} as ControllerMetrics,
      playgroundModel: new OpenAICompatiblePlaygroundModel({
        provider: "DeepSeek", baseUrl: "https://model.test", model: "deepseek-test", apiKey: "key", fetcher: modelFetch,
      }),
      playgroundRunner: new RunnerPlaygroundClient({ baseUrl: "https://runtime.test", token: config.runnerToken, fetcher: runnerFetch }),
    });

    const prepared = await app.request("/api/v1/playground/draft-previews/guardrail-draft", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(prepared.status).toBe(201);
    const preview = await prepared.json() as { preview_id: string };
    const interaction = await app.request("/api/v1/playground/draft-interactions/guardrail-draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preview_id: preview.preview_id, model_id: "deepseek-test", message: "hello draft", history: [] }),
    });

    expect(interaction.status).toBe(200);
    await expect(interaction.json()).resolves.toMatchObject({
      state: "completed",
      assistant_message: "draft answer",
      input_check: {
        evidence_id: null,
        guardrail: { id: "guardrail-draft", target_kind: "draft", draft_revision: 7, published_at: null },
      },
    });
    expect(runnerFetch).toHaveBeenCalledTimes(3);
    expect(modelFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects draft preview preparation for non-administrators", async () => {
    const prepare = vi.fn();
    const app = createHttpApp({
      config,
      auth: {
        api: { getSession: vi.fn().mockResolvedValue({ user: { id: "member-1", role: "user" } }) },
        handler: vi.fn(),
      } as unknown as ControllerAuth,
      service: { playgroundDraftCandidate: prepare } as unknown as ControlPlaneService,
      runnerControl: {} as RunnerControlServer,
      metrics: {} as ControllerMetrics,
      playgroundModel: {} as OpenAICompatiblePlaygroundModel,
      playgroundRunner: {} as RunnerPlaygroundClient,
    });

    const response = await app.request("/api/v1/playground/draft-previews/guardrail-draft", { method: "POST" });
    expect(response.status).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("lists the configured model and runs real input-model-output checkpoints on an immutable version", async () => {
    const versionId = "20260904-074000.456Z";
    const modelFetch = vi.fn(async () => Response.json({ choices: [{ message: { content: "model answer" } }] })) as typeof fetch;
    const runnerFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { phase: string; guardrail_version: string };
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${config.runnerToken}` });
      expect(request.guardrail_version).toBe(versionId);
      return Response.json({
        decision: "allow",
        action: "pass",
        reason: `${request.phase} passed`,
        texts: [],
        guardrail_id: "guardrail-default",
        guardrail_version: versionId,
        findings: [],
        trace: [{ id: `${request.phase}-1`, kind: "action", name: "PII", status: "complete", detail: "checked", duration_ms: 2 }],
        usage: { runtime_engine: "llmrails", runtime_profile: "llmrails_colang1_standard" },
      });
    }) as typeof fetch;
    const app = createHttpApp({
      config,
      auth: {
        api: { getSession: vi.fn().mockResolvedValue({ user: { id: "member-1", role: "user" } }) },
        handler: vi.fn(),
      } as unknown as ControllerAuth,
      service: {
        getGuardrail: vi.fn().mockResolvedValue({
          id: "guardrail-default",
          name: "Default Guardrail",
          versions: [{
            version: versionId,
            status: "ready",
            artifactId: "artifact-3",
            createdAt: new Date("2026-08-20T00:00:00Z"),
            plan: { compiler_version: "runner-compiler-v3" },
          }],
        }),
      } as unknown as ControlPlaneService,
      runnerControl: {} as RunnerControlServer,
      metrics: {} as ControllerMetrics,
      playgroundModel: new OpenAICompatiblePlaygroundModel({
        provider: "DeepSeek",
        baseUrl: "https://model.test",
        model: "deepseek-test",
        apiKey: "model-key",
        fetcher: modelFetch,
      }),
      playgroundRunner: new RunnerPlaygroundClient({
        baseUrl: "https://runtime.test",
        token: config.runnerToken,
        fetcher: runnerFetch,
      }),
    });

    const models = await app.request("/api/v1/playground/models");
    const interaction = await app.request("/api/v1/playground/interactions/guardrail-default", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guardrail_version: versionId,
        model_id: "deepseek-test",
        message: "hello",
        history: [],
      }),
    });

    expect(models.status).toBe(200);
    await expect(models.json()).resolves.toMatchObject({ count: 1, items: [{ id: "deepseek-test", provider: "DeepSeek" }] });
    expect(interaction.status).toBe(200);
    await expect(interaction.json()).resolves.toMatchObject({
      state: "completed",
      assistant_message: "model answer",
      input_check: { phase: "input", guardrail: { id: "guardrail-default", version: versionId } },
      output_check: { phase: "output", guardrail: { id: "guardrail-default", version: versionId } },
    });
    expect(runnerFetch).toHaveBeenCalledTimes(2);
    expect(modelFetch).toHaveBeenCalledTimes(1);
  });

  it("does not call the model after the input Guardrail blocks", async () => {
    const versionId = "20260904-075000.789Z";
    const modelFetch = vi.fn();
    const runnerFetch = vi.fn(async () => Response.json({
      decision: "block",
      action: "reject",
      reason: "PII blocked",
      texts: [],
      findings: [{
        risk: "pii",
        taxonomy_id: "TALI-PRIVACY-PII",
        verdict: "unsafe",
        confidence: 0.99,
        evidence: "PII detected",
        recommended_action: "reject",
        policy_id: "privacy",
        rule_id: "pii",
      }],
      trace: [],
    })) as typeof fetch;
    const playgroundModel = new OpenAICompatiblePlaygroundModel({
      provider: "DeepSeek", baseUrl: "https://model.test", model: "deepseek-test", apiKey: "key", fetcher: modelFetch as typeof fetch,
    });
    const playgroundRunner = new RunnerPlaygroundClient({ baseUrl: "https://runtime.test", token: config.runnerToken, fetcher: runnerFetch });
    const auth = {
      api: { getSession: vi.fn().mockResolvedValue({ user: { id: "member-1", role: "user" } }) }, handler: vi.fn(),
    } as unknown as ControllerAuth;
    const app = createHttpApp({
      config, auth,
      service: { getGuardrail: vi.fn().mockResolvedValue({
        id: "guardrail-default", name: "Default Guardrail",
        versions: [{ version: versionId, status: "ready", artifactId: "artifact-1", createdAt: new Date(), plan: {} }],
      }) } as unknown as ControlPlaneService,
      runnerControl: {} as RunnerControlServer,
      metrics: {} as ControllerMetrics,
      playgroundModel,
      playgroundRunner,
    });

    const response = await app.request("/api/v1/playground/interactions/guardrail-default", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ guardrail_version: versionId, model_id: "deepseek-test", message: "secret", history: [] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ state: "input_blocked", assistant_message: null });
    expect(modelFetch).not.toHaveBeenCalled();
    expect(runnerFetch).toHaveBeenCalledTimes(1);
  });
});
