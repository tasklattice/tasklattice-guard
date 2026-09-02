import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { serveStatic } from "@hono/node-server/serve-static";
import { prometheus } from "@hono/prometheus";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";

import type { ControllerAuth } from "../auth.js";
import type { ControllerConfig } from "../config.js";
import type { IntentAnalyzer } from "../control-plane-ai/intent-analyzer.js";
import { ControllerError, NotFoundError, ValidationError } from "../domain/errors.js";
import { enforcementActions, protectionIds } from "../domain/guardrail-plan.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import type { ControllerMetrics } from "../metrics.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { actionCatalog } from "../action-catalog/catalog.js";
import { createProgrammablePolicySchema, updateProgrammablePolicySchema } from "../policy-studio/model.js";
import { extractDocuments } from "../control-plane-ai/document-ingestion.js";
import {
  type OpenAICompatiblePlaygroundModel,
  PlaygroundDraftPreviewStore,
  type RunnerPlaygroundClient,
  runPlaygroundInteraction,
} from "../playground/service.js";

type Actor = { id: string; role: string };
type Variables = { actor: Actor };

const guardrailPolicyBindingInput = z.object({
  policyId: z.string().trim().min(1).max(256),
  policyVersion: z.string().trim().min(1).max(128),
  action: z.enum(enforcementActions).nullable().default(null),
  parameterValues: z.record(z.string(), z.string()).default({}),
  enabledRuleIds: z.array(z.string().min(1)).max(512).default([]),
  ruleActions: z.record(z.string(), z.enum(enforcementActions)).default({}),
  enabledRails: z.array(z.enum(["input", "output", "retrieval", "dialog", "execution"])).default([]),
  reasoningPolicy: z.object({
    policyId: z.string().trim().min(1),
    policyVersion: z.string().trim().min(1),
    confidenceThreshold: z.number().min(0).max(1).default(0.8),
  }).nullable().default(null),
});
const guardrailDraftInput = z.object({
  protections: z.array(z.enum(protectionIds)).optional(),
  purposeDetails: z.object({
    audience: z.string().trim().max(500).default(""),
    tasks: z.string().trim().max(2_000).default(""),
    protect: z.string().trim().max(2_000).default(""),
    outOfScope: z.string().trim().max(2_000).default(""),
  }).default({ audience: "", tasks: "", protect: "", outOfScope: "" }),
  allowedTopics: z.array(z.string().trim().min(1).max(500)).max(256).default([]),
  restrictedTopics: z.array(z.string().trim().min(1).max(500)).max(256).default([]),
  policyBindings: z.array(guardrailPolicyBindingInput).min(1).max(128),
  safetyLevel: z.enum(["balanced", "strict"]).default("balanced"),
  outputDelivery: z.enum(["interruptible", "window_buffered", "full_buffered"]).default("full_buffered"),
  customContentRules: z.array(z.object({
    id: z.string().trim().min(1).max(160),
    phases: z.array(z.enum(["input", "output"])).min(1).max(2),
    detector: z.enum(["keyword", "regex"]),
    keywords: z.array(z.string().trim().min(1).max(240)).max(50).optional(),
    expression: z.string().trim().max(500).optional(),
    action: z.enum(enforcementActions),
    replacement: z.string().trim().max(240).optional(),
  })).max(50).default([]),
});
const guardrailInput = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4_000).default(""),
  draftConfig: guardrailDraftInput,
  runtimeProfile: z.enum(["auto", "llmrails_colang1_standard", "llmrails_colang2_programmable", "iorails_native"]).default("auto"),
});
const guardrailUpdateInput = guardrailInput.partial();
const intentAnalysisInput = z.object({
  purpose: z.string().trim().min(20).max(2_000),
  language: z.enum(["en", "zh-CN"]).default("en"),
});
const loggingInput = z.object({ level: z.enum(["info", "debug", "trace"]), acknowledgeCost: z.boolean().default(false) });
const testCaseInput = z.object({
  guardrailId: z.string().min(1),
  name: z.string().trim().min(1).max(160),
  policyId: z.string().trim().max(256).default("custom"),
  phase: z.enum(["input", "output"]),
  content: z.string().min(1).max(8_000),
  expectedDecision: z.enum(["allow", "block", "transform", "intervene"]),
  trustedInstruction: z.string().max(8_000).default(""),
  targetSource: z.enum(["user_input", "retrieved_content", "tool_output", "model_output"]).default("user_input"),
  query: z.string().max(1_000).default(""),
  groundingSources: z.array(z.string().max(8_000)).max(32).default([]),
  expectedReasoningResult: z.string().nullable().default(null),
});
const validationScopeInput = z.object({ caseId: z.string().min(1), excluded: z.boolean() });
const validationRunInput = z.object({ guardrailId: z.string().min(1) });
const playgroundInteractionInput = z.object({
  guardrail_version: z.number().int().positive(),
  model_id: z.string().trim().min(1).max(256),
  message: z.string().trim().min(1).max(32_000),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(32_000),
  })).max(40).default([]),
});
const playgroundDraftInteractionInput = playgroundInteractionInput.omit({ guardrail_version: true }).extend({
  preview_id: z.string().uuid(),
});
const integrationInput = z.object({
  name: z.string().trim().min(1).max(160),
  adapter: z.string().trim().min(1).max(80),
});
const integrationEnabledInput = z.object({ enabled: z.boolean() });
const deletionInput = z.object({
  reason: z.string().trim().min(1).max(1_000),
  confirmRecentTraffic: z.boolean().default(false),
  confirmationName: z.string().trim().max(160).optional(),
});
type TrafficScope = { combinator: "and" | "or"; conditions: Array<TrafficCondition | TrafficScope> };
type TrafficCondition = { field: string; key: string; operator: "equals" | "contains" | "starts_with" | "glob"; value: string };
const trafficConditionInput = z.object({
  field: z.string().trim().min(1).max(120),
  key: z.string().trim().max(120).default(""),
  operator: z.enum(["equals", "contains", "starts_with", "glob"]),
  value: z.string().min(1).max(500),
});
const trafficScopeInput: z.ZodType<TrafficScope> = z.lazy(() => z.object({
  combinator: z.enum(["and", "or"]).default("and"),
  conditions: z.array(z.union([trafficConditionInput, trafficScopeInput])).max(16).default([]),
}));
const deploymentInput = z.object({
  name: z.string().trim().min(1).max(160),
  guardrailId: z.string().min(1),
  integrationId: z.string().min(1),
  poolId: z.string().min(1).default("default"),
  trafficScope: trafficScopeInput.default({ combinator: "and", conditions: [] }),
  enabled: z.boolean().default(true),
});
const deploymentBindingsInput = deploymentInput.omit({ integrationId: true }).extend({ integrationIds: z.array(z.string().min(1)).min(1).max(50) });
const deploymentEnabledInput = z.object({ enabled: z.boolean() });
const deploymentScopeInput = z.object({ trafficScope: trafficScopeInput });
const deploymentOrderInput = z.object({ deploymentIds: z.array(z.string().min(1)).min(1).max(100) });
const runnerPoolInput = z.object({
  desiredReplicas: z.number().int().min(1).max(1_000),
  safeRpsPerRunner: z.number().positive().max(1_000_000),
  maxConcurrencyPerRunner: z.number().int().min(1).max(100_000),
});
const runtimeEventInput = z.object({
  id: z.string().min(1),
  occurredAt: z.coerce.date(),
  requestId: z.string().min(1),
  runnerId: z.string().min(1),
  guardrailId: z.string().optional(),
  guardrailVersion: z.number().int().positive().optional(),
  integrationId: z.string().optional(),
  deploymentId: z.string().optional(),
  direction: z.enum(["incoming", "outgoing"]),
  decision: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const runtimeEventBatchInput = z.object({
  events: z.array(runtimeEventInput).max(1_000),
  runnerId: z.string().min(1).optional(),
  observedAt: z.coerce.date().optional(),
}).superRefine((value, context) => {
  if (value.events.length === 0 && !value.runnerId) {
    context.addIssue({ code: "custom", path: ["runnerId"], message: "runnerId is required for an empty telemetry batch." });
  }
});

export function createHttpApp(input: {
  config: ControllerConfig;
  auth: ControllerAuth;
  service: ControlPlaneService;
  runnerControl: RunnerControlServer;
  metrics: ControllerMetrics;
  intentAnalyzer?: IntentAnalyzer | null;
  playgroundModel?: OpenAICompatiblePlaygroundModel | null;
  playgroundRunner?: RunnerPlaygroundClient | null;
}) {
  const app = new Hono<{ Variables: Variables }>();
  const { registerMetrics } = prometheus({
    registry: input.metrics.registry,
    prefix: "guard_controller_",
    collectDefaultMetrics: false,
  });
  const policyCatalog = PolicyCatalog.load(input.config.policyCatalogDir);
  const intentAnalyzer = input.intentAnalyzer ?? null;
  const playgroundModel = input.playgroundModel ?? null;
  const playgroundRunner = input.playgroundRunner ?? null;
  const playgroundDraftPreviews = new PlaygroundDraftPreviewStore();
  const withDistribution = async <T extends Record<string, unknown>>(resource: T, wait = false) => ({
    ...resource,
    ...(wait ? await input.runnerControl.distributeDesiredState() : await input.runnerControl.distributionStatus()),
  });
  app.use("*", logger());
  app.use("*", secureHeaders());
  app.use("*", (context, next) => {
    if (context.req.path === "/metrics" || context.req.path.startsWith("/health/")) {
      return next();
    }
    return registerMetrics(context, next);
  });

  app.get("/health/live", (context) => context.json({ status: "ok", component: "guard-controller" }));
  app.get("/health/ready", async (context) => {
    const desiredGeneration = await input.service.desiredGeneration();
    return context.json({ status: "ready", component: "guard-controller", desiredGeneration });
  });
  app.get("/metrics", metricsAuthentication(input.config.metricsToken), async (context) => context.text(
    await input.metrics.render(input.service),
    200,
    { "content-type": input.metrics.registry.contentType },
  ));
  app.get("/api/v1/system/status", async (context) => {
    const pools = await input.service.listRunnerPoolsWithCapacity();
    const defaultPool = pools.find((pool) => pool.isDefault);
    const defaultRunnerReady = Boolean(defaultPool && defaultPool.capacity.readyRunners > 0);
    return context.json({
      status: defaultRunnerReady ? "ready" : "degraded",
      deploymentComplete: defaultRunnerReady,
      desiredGeneration: await input.service.desiredGeneration(),
      defaultRunnerReady,
      modelConnections: input.config.modelConnections,
    }, defaultRunnerReady ? 200 : 503);
  });

  app.on(["GET", "POST"], "/api/auth/*", (context) => input.auth.handler(context.req.raw));

  const authenticated = authentication(input.auth);
  const administrator = authorization("admin");

  app.get("/api/v1/policies", authenticated, async (context) => {
    const items = await input.service.listPolicies();
    return context.json({ items, count: items.length });
  });
  app.get("/api/v1/policies/:id", authenticated, async (context) => context.json(await input.service.getPolicy(context.req.param("id"))));
  app.post("/api/v1/policies", authenticated, administrator, async (context) => {
    const body = createProgrammablePolicySchema.parse(await context.req.json());
    return context.json(await input.service.createPolicy({ ...body, actorId: context.get("actor").id }), 201);
  });
  app.patch("/api/v1/policies/:id", authenticated, administrator, async (context) => {
    const body = updateProgrammablePolicySchema.parse(await context.req.json());
    return context.json(await input.service.updatePolicy({ id: context.req.param("id"), ...body, actorId: context.get("actor").id }));
  });
  app.delete("/api/v1/policies/:id", authenticated, administrator, async (context) => {
    await input.service.deletePolicy({ id: context.req.param("id"), actorId: context.get("actor").id });
    return context.body(null, 204);
  });
  app.post("/api/v1/policies/:id/validate", authenticated, administrator, async (context) => {
    return context.json(await input.service.validatePolicy(context.req.param("id")));
  });
  app.get("/api/v1/policies/:id/validation-runs/latest", authenticated, async (context) => {
    return context.json(await input.service.latestPolicyValidation(context.req.param("id")));
  });
  app.post("/api/v1/policies/:id/validation-runs", authenticated, administrator, async (context) => {
    return context.json(await input.service.requestPolicyValidation({
      id: context.req.param("id"), actorId: context.get("actor").id,
      compilerAvailable: input.runnerControl.hasDefaultCompiler(),
    }), 202);
  });
  app.post("/api/v1/policies/:id/publish", authenticated, administrator, async (context) => {
    return context.json(await input.service.publishPolicy({ id: context.req.param("id"), actorId: context.get("actor").id }), 201);
  });
  app.get("/api/v1/actions", authenticated, (context) => {
    const items = actionCatalog();
    return context.json({ items, count: items.length });
  });

  app.get("/api/v1/intent-analysis-status", authenticated, (context) => context.json({
    available: intentAnalyzer !== null,
    provider: intentAnalyzer?.provider ?? null,
    model: intentAnalyzer?.model ?? null,
    document_analysis_available: intentAnalyzer !== null,
  }));
  app.post("/api/v1/intent-analyses", authenticated, administrator, async (context) => {
    if (!intentAnalyzer) {
      throw new ControllerError(
        "The control-plane assistant is not configured.",
        503,
        "intent_analysis_unavailable",
      );
    }
    const body = intentAnalysisInput.parse(await context.req.json());
    return context.json(await intentAnalyzer.analyze(body));
  });
  app.post("/api/v1/compliance-document-analyses", authenticated, administrator, async (context) => {
    if (!intentAnalyzer) {
      throw new ControllerError("The control-plane assistant is not configured.", 503, "intent_analysis_unavailable");
    }
    const form = await context.req.formData();
    const language = form.get("language") === "zh-CN" ? "zh-CN" : "en";
    const files = form.getAll("files").filter((item): item is File => item instanceof File);
    const documents = await extractDocuments(files);
    const policies = (await input.service.listPolicies()).map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
    }));
    const analysis = await intentAnalyzer.analyzeDocuments({ documents, policies, language });
    return context.json({
      ...analysis,
      sources: documents.map(({ sections: _sections, ...source }) => source),
    });
  });

  app.get("/api/v1/guardrails", authenticated, async (context) => context.json({ items: await input.service.listGuardrails() }));
  app.get("/api/v1/playground/models", authenticated, (context) => {
    const items = playgroundModel ? [playgroundModel.descriptor] : [];
    return context.json({ items, count: items.length });
  });
  app.post("/api/v1/playground/draft-previews/:guardrailId", authenticated, administrator, async (context) => {
    if (!playgroundModel || !playgroundRunner) {
      throw new ControllerError("Guardrail Playground has no model connection configured.", 503, "playground_unavailable");
    }
    const candidate = await input.service.playgroundDraftCandidate(context.req.param("guardrailId"));
    const preview = playgroundDraftPreviews.create({
      actorId: context.get("actor").id,
      guardrailId: candidate.guardrailId,
      guardrailName: candidate.guardrailName,
      draftRevision: candidate.draftRevision,
      candidateVersion: candidate.candidateVersion,
      plan: candidate.plan,
      runtimeProfile: candidate.runtimeProfile,
      compilerVersion: candidate.compilerVersion,
    });
    try {
      const prepared = await playgroundRunner.prepareDraft(preview);
      preview.compilerVersion = prepared.compiler_version;
      return context.json({
        preview_id: preview.previewId,
        guardrail_id: preview.guardrailId,
        draft_revision: preview.draftRevision,
        candidate_version: preview.candidateVersion,
        compiler_version: prepared.compiler_version,
        runtime_profile: prepared.runtime_profile,
        expires_at: preview.expiresAt.toISOString(),
      }, 201);
    } catch (error) {
      playgroundDraftPreviews.delete(preview.previewId);
      throw error;
    }
  });
  app.post("/api/v1/playground/draft-interactions/:guardrailId", authenticated, administrator, async (context) => {
    if (!playgroundModel || !playgroundRunner) {
      throw new ControllerError("Guardrail Playground has no model connection configured.", 503, "playground_unavailable");
    }
    const body = playgroundDraftInteractionInput.parse(await context.req.json());
    const actorId = context.get("actor").id;
    const preview = playgroundDraftPreviews.get(body.preview_id, actorId);
    if (preview.guardrailId !== context.req.param("guardrailId")) {
      throw new ControllerError("Draft preview does not belong to this Guardrail.", 409, "playground_draft_preview_stale");
    }
    const guardrail = await input.service.getGuardrail(preview.guardrailId);
    if (guardrail.draftRevision !== preview.draftRevision) {
      playgroundDraftPreviews.delete(preview.previewId);
      throw new ControllerError("The Guardrail draft changed. Prepare a new preview before testing.", 409, "playground_draft_revision_changed");
    }
    return context.json(await runPlaygroundInteraction({
      guardrail: {
        id: preview.guardrailId,
        name: preview.guardrailName,
        version: preview.candidateVersion,
        publishedAt: null,
        compilerVersion: preview.compilerVersion,
        targetKind: "draft",
        draftRevision: preview.draftRevision,
      },
      target: preview,
      model: playgroundModel,
      runner: playgroundRunner,
      modelId: body.model_id,
      message: body.message,
      history: body.history,
    }));
  });
  app.post("/api/v1/playground/interactions/:guardrailId", authenticated, async (context) => {
    if (!playgroundModel || !playgroundRunner) {
      throw new ControllerError("Guardrail Playground has no model connection configured.", 503, "playground_unavailable");
    }
    const body = playgroundInteractionInput.parse(await context.req.json());
    const guardrail = await input.service.getGuardrail(context.req.param("guardrailId"));
    const version = guardrail.versions.find((item) => item.version === body.guardrail_version);
    if (!version || version.status !== "ready" || !version.artifactId) {
      throw new ValidationError("Playground requires a ready, immutable Guardrail Version.");
    }
    return context.json(await runPlaygroundInteraction({
      guardrail: {
        id: guardrail.id,
        name: guardrail.name,
        version: version.version,
        publishedAt: version.createdAt,
        compilerVersion: typeof version.plan.compiler_version === "string"
          ? version.plan.compiler_version
          : "TaskLattice Guard Runner",
        targetKind: "published",
        draftRevision: null,
      },
      target: { kind: "published", version: version.version },
      model: playgroundModel,
      runner: playgroundRunner,
      modelId: body.model_id,
      message: body.message,
      history: body.history,
    }));
  });
  app.post("/api/v1/guardrail-plan-previews", authenticated, administrator, async (context) => {
    const body = guardrailInput.parse(await context.req.json());
    return context.json(await input.service.previewGuardrailPlan(body));
  });
  app.post("/api/v1/guardrails", authenticated, administrator, async (context) => {
    const body = guardrailInput.parse(await context.req.json());
    return context.json(await input.service.createGuardrail({ ...body, actorId: context.get("actor").id }), 201);
  });
  app.get("/api/v1/guardrails/:id", authenticated, async (context) => {
    return context.json(await input.service.getGuardrail(context.req.param("id")));
  });
  app.patch("/api/v1/guardrails/:id", authenticated, administrator, async (context) => {
    const body = guardrailUpdateInput.parse(await context.req.json());
    return context.json(await input.service.updateGuardrail({
      id: context.req.param("id"), actorId: context.get("actor").id, ...body,
    }));
  });
  app.post("/api/v1/guardrails/:id/publish", authenticated, administrator, async (context) => {
    return context.json(await input.service.requestGuardrailPublish({
      guardrailId: context.req.param("id"),
      actorId: context.get("actor").id,
      compilerAvailable: input.runnerControl.hasDefaultCompiler(),
    }), 202);
  });
  app.post("/api/v1/guardrails/:id/rollback/:version", authenticated, administrator, async (context) => {
    const version = z.coerce.number().int().positive().parse(context.req.param("version"));
    const result = await input.service.rollbackGuardrail({
      guardrailId: context.req.param("id"), version, actorId: context.get("actor").id,
    });
    await input.runnerControl.distributeDesiredState();
    return context.json(result);
  });
  app.get("/api/v1/guardrails/:id/logging", authenticated, async (context) => {
    return context.json(await input.service.guardrailLogging(context.req.param("id")));
  });
  app.patch("/api/v1/guardrails/:id/logging", authenticated, administrator, async (context) => {
    const body = loggingInput.parse(await context.req.json());
    if (body.level !== "info" && !body.acknowledgeCost) {
      return context.json({ error: { code: "logging_cost_acknowledgement_required", message: "Debug and Trace logging require an explicit cost acknowledgement." } }, 409);
    }
    const updated = await input.service.updateGuardrailLogging({
      id: context.req.param("id"), level: body.level, actorId: context.get("actor").id,
    });
    await input.runnerControl.distributeDesiredState();
    return context.json(updated);
  });
  app.get("/api/v1/guardrails/:id/deletion-impact", authenticated, administrator, async (context) => {
    return context.json(await input.service.guardrailDeletionImpact(context.req.param("id")));
  });
  app.delete("/api/v1/guardrails/:id", authenticated, administrator, async (context) => {
    const body = deletionInput.parse(await context.req.json());
    await input.service.softDeleteGuardrail({ id: context.req.param("id"), actorId: context.get("actor").id, ...body });
    await input.runnerControl.distributeDesiredState();
    return context.body(null, 204);
  });

  app.get("/api/v1/test-cases", authenticated, async (context) => {
    const guardrailId = z.string().min(1).parse(context.req.query("guardrailId"));
    const items = await input.service.listTestCases(guardrailId);
    return context.json({ items, count: items.length });
  });
  app.post("/api/v1/test-cases", authenticated, administrator, async (context) => {
    const body = testCaseInput.parse(await context.req.json());
    return context.json(await input.service.createTestCase({ ...body, actorId: context.get("actor").id }), 201);
  });
  app.delete("/api/v1/test-cases/:caseId", authenticated, administrator, async (context) => {
    await input.service.deleteTestCase({ caseId: context.req.param("caseId"), actorId: context.get("actor").id });
    return context.body(null, 204);
  });
  app.patch("/api/v1/guardrails/:id/validation-scope", authenticated, administrator, async (context) => {
    const body = validationScopeInput.parse(await context.req.json());
    return context.json(await input.service.setTestCaseExcluded({
      guardrailId: context.req.param("id"), caseId: body.caseId, excluded: body.excluded,
      actorId: context.get("actor").id,
    }));
  });
  app.get("/api/v1/validation-runs", authenticated, async (context) => {
    const items = await input.service.listValidationRuns(context.req.query("guardrailId"));
    return context.json({ items, count: items.length });
  });
  app.get("/api/v1/validation-runs/:runId", authenticated, async (context) => {
    return context.json(await input.service.getValidationRun(context.req.param("runId")));
  });
  app.post("/api/v1/validation-runs", authenticated, administrator, async (context) => {
    const body = validationRunInput.parse(await context.req.json());
    return context.json(await input.service.requestValidation({
      guardrailId: body.guardrailId,
      actorId: context.get("actor").id,
      compilerAvailable: input.runnerControl.hasDefaultCompiler(),
    }), 202);
  });

  app.get("/api/v1/integrations", authenticated, async (context) => {
    const [items, distribution] = await Promise.all([
      input.service.listIntegrations(),
      input.runnerControl.distributionStatus(),
    ]);
    return context.json({ items: items.map((item) => ({ ...item, ...distribution })) });
  });
  app.post("/api/v1/integrations", authenticated, administrator, async (context) => {
    const body = integrationInput.parse(await context.req.json());
    const created = await input.service.createIntegration({ ...body, actorId: context.get("actor").id });
    return context.json(await withDistribution(created, true), 201);
  });
  app.get("/api/v1/integrations/:id", authenticated, async (context) => {
    return context.json(await withDistribution(await input.service.getIntegration(context.req.param("id"))));
  });
  app.patch("/api/v1/integrations/:id", authenticated, administrator, async (context) => {
    const body = integrationEnabledInput.parse(await context.req.json());
    const updated = await input.service.setIntegrationEnabled({
      id: context.req.param("id"),
      enabled: body.enabled,
      actorId: context.get("actor").id,
    });
    return context.json(await withDistribution(updated, true));
  });
  app.post("/api/v1/integrations/:id/credentials", authenticated, administrator, async (context) => {
    const updated = await input.service.rotateIntegrationCredential({
      id: context.req.param("id"),
      actorId: context.get("actor").id,
    });
    return context.json(await withDistribution(updated, true), 201);
  });
  app.delete("/api/v1/integrations/:id/credentials/:credentialId", authenticated, administrator, async (context) => {
    await input.service.revokeIntegrationCredential({
      id: context.req.param("id"),
      credentialId: context.req.param("credentialId"),
      actorId: context.get("actor").id,
    });
    await input.runnerControl.distributeDesiredState();
    return context.body(null, 204);
  });
  app.get("/api/v1/integrations/:id/deletion-impact", authenticated, administrator, async (context) => {
    return context.json(await input.service.integrationDeletionImpact(context.req.param("id")));
  });
  app.delete("/api/v1/integrations/:id", authenticated, administrator, async (context) => {
    const body = deletionInput.parse(await context.req.json());
    await input.service.softDeleteIntegration({ id: context.req.param("id"), actorId: context.get("actor").id, ...body });
    await input.runnerControl.distributeDesiredState();
    return context.body(null, 204);
  });

  app.get("/api/v1/runner-pools", authenticated, async (context) => context.json({ items: await input.service.listRunnerPoolsWithCapacity() }));
  app.patch("/api/v1/runner-pools/:id", authenticated, administrator, async (context) => {
    const body = runnerPoolInput.parse(await context.req.json());
    return context.json(await input.service.updateRunnerPool({ id: context.req.param("id"), actorId: context.get("actor").id, ...body }));
  });
  app.delete("/api/v1/runner-instances/:runnerId", authenticated, administrator, async (context) => {
    await input.service.removeRunnerInstance({
      runnerId: context.req.param("runnerId"),
      actorId: context.get("actor").id,
    });
    return context.body(null, 204);
  });
  app.get("/api/v1/deployments", authenticated, async (context) => context.json({ items: await input.service.listDeployments() }));
  app.get("/api/v1/deployments/:id", authenticated, async (context) => context.json(await input.service.getDeployment(context.req.param("id"))));
  app.get("/api/v1/deployments/:id/deletion-impact", authenticated, administrator, async (context) => {
    return context.json(await input.service.deploymentDeletionImpact(context.req.param("id")));
  });
  app.post("/api/v1/deployments", authenticated, administrator, async (context) => {
    const body = deploymentInput.parse(await context.req.json());
    assertTrafficScopeSupported(body.trafficScope);
    const created = await input.service.createDeployment({ ...body, actorId: context.get("actor").id });
    await input.runnerControl.distributeDesiredState();
    return context.json(created, 201);
  });
  app.post("/api/v1/deployment-bindings", authenticated, administrator, async (context) => {
    const body = deploymentBindingsInput.parse(await context.req.json());
    assertTrafficScopeSupported(body.trafficScope);
    const items = await input.service.createDeploymentBindings({ ...body, actorId: context.get("actor").id });
    await input.runnerControl.distributeDesiredState();
    return context.json({ items, count: items.length }, 201);
  });
  app.patch("/api/v1/deployments/:id", authenticated, administrator, async (context) => {
    const body = deploymentEnabledInput.parse(await context.req.json());
    const updated = await input.service.setDeploymentEnabled({ id: context.req.param("id"), enabled: body.enabled, actorId: context.get("actor").id });
    await input.runnerControl.distributeDesiredState();
    return context.json(updated);
  });
  app.put("/api/v1/deployments/:id/traffic-scope", authenticated, administrator, async (context) => {
    const body = deploymentScopeInput.parse(await context.req.json());
    assertTrafficScopeSupported(body.trafficScope);
    const updated = await input.service.updateDeploymentTrafficScope({ id: context.req.param("id"), trafficScope: body.trafficScope, actorId: context.get("actor").id });
    await input.runnerControl.distributeDesiredState();
    return context.json(updated);
  });
  app.delete("/api/v1/deployments/:id", authenticated, administrator, async (context) => {
    const body = deletionInput.parse(await context.req.json());
    await input.service.softDeleteDeployment({ id: context.req.param("id"), actorId: context.get("actor").id, ...body });
    await input.runnerControl.distributeDesiredState();
    return context.body(null, 204);
  });
  app.put("/api/v1/integrations/:integrationId/deployment-order", authenticated, administrator, async (context) => {
    const body = deploymentOrderInput.parse(await context.req.json());
    const items = await input.service.reorderDeploymentRoutes({ integrationId: context.req.param("integrationId"), deploymentIds: body.deploymentIds, actorId: context.get("actor").id });
    await input.runnerControl.distributeDesiredState();
    return context.json({ items, count: items.length });
  });
  app.get("/api/v1/traffic-scope-fields", authenticated, (context) => {
    const items = trafficScopeFields();
    return context.json({ items, count: items.length });
  });
  app.get("/api/v1/runtime-events", authenticated, async (context) => {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(10_000).default(100),
      guardrailId: z.string().min(1).optional(),
      deploymentId: z.string().min(1).optional(),
      integrationId: z.string().min(1).optional(),
      since: z.coerce.date().optional(),
      before: z.coerce.date().optional(),
    }).parse(context.req.query());
    return context.json(await input.service.queryRuntimeEvents(query));
  });
  app.get("/api/v1/audit-events", authenticated, async (context) => {
    const limit = z.coerce.number().int().min(1).max(500).default(100).parse(context.req.query("limit"));
    return context.json({ items: await input.service.listAuditEvents(limit) });
  });

  app.post("/api/internal/v1/runtime-events", runnerAuthentication(input.config.runnerToken), async (context) => {
    const body = runtimeEventBatchInput.parse(await context.req.json());
    try {
      await input.service.recordRuntimeEvents(body.events);
      if (body.runnerId) await input.service.recordTelemetryWatermark(body.runnerId);
      input.metrics.observeTelemetryBatch?.(
        "accepted", body.events.map((event) => event.occurredAt), body.events.length,
      );
      return context.json({ accepted: body.events.length }, 202);
    } catch (error) {
      input.metrics.observeTelemetryBatch?.(
        "error", body.events.map((event) => event.occurredAt), body.events.length,
      );
      throw error;
    }
  });

  app.notFound((context) => {
    if (context.req.path.startsWith("/api/") || context.req.path.startsWith("/health/")) {
      return context.json({ error: { code: "not_found", message: "Route not found." } }, 404);
    }
    return context.notFound();
  });
  app.onError((error, context) => {
    if (error instanceof ControllerError) {
      return context.json({ error: { code: error.code, message: error.message, detail: error.detail } }, error.status as 400);
    }
    if (error instanceof z.ZodError) {
      return context.json({ error: { code: "invalid_request", message: "Request validation failed.", detail: error.flatten() } }, 400);
    }
    console.error(error);
    return context.json({ error: { code: "internal_error", message: "Internal Controller error." } }, 500);
  });

  const uiRoot = resolve(input.config.uiDist);
  if (existsSync(uiRoot)) {
    app.use("/assets/*", serveStatic({ root: uiRoot }));
    app.get("/favicon.ico", serveStatic({ root: uiRoot, path: "favicon.ico" }));
    app.get("*", serveStatic({ root: uiRoot, path: "index.html" }));
  }
  return app;
}

function authentication(auth: ControllerAuth): MiddlewareHandler<{ Variables: Variables }> {
  return async (context, next) => {
    const session = await auth.api.getSession({ headers: context.req.raw.headers });
    if (!session) return context.json({ error: { code: "unauthenticated", message: "Authentication is required." } }, 401);
    context.set("actor", { id: session.user.id, role: session.user.role ?? "user" });
    await next();
  };
}

function authorization(role: string): MiddlewareHandler<{ Variables: Variables }> {
  return async (context, next) => {
    if (context.get("actor").role !== role) {
      return context.json({ error: { code: "forbidden", message: `${role} role is required.` } }, 403);
    }
    await next();
  };
}

function trafficScopeFields() {
  return [
    field("protocol", "request", "field", "protocol", ["equals"], ["http", "litellm", "a2a"]),
    field("output.sink", "request", "field", "output.sink", ["equals"], ["display", "markdown", "html", "sql", "shell", "url", "json", "tool_argument"]),
    field("output.content_type", "request", "field", "output.content_type", ["equals", "glob"]),
    field("output.schema_id", "request", "field", "output.schema_id", ["equals", "glob"]),
    field("tool.name", "request", "field", "tool.name", ["equals", "glob"]),
    field("target.environment", "request", "field", "target.environment", ["equals", "glob"]),
    field("auth.principal", "authentication", "field", "auth.principal", ["equals", "glob"]),
    field("integration.id", "authentication", "field", "integration.id", ["equals"]),
    field("http.method", "http", "field", "http.method", ["equals"], ["GET", "POST", "PUT", "PATCH", "DELETE"]),
    field("http.host", "http", "field", "http.host", ["equals", "glob"]),
    field("http.path", "http", "field", "http.path", ["equals", "starts_with", "glob"]),
    field("http.header", "http", "header", "", ["equals", "contains", "starts_with", "glob"], [], true),
    field("auth.jwt_claim", "authentication", "jwt_claim", "", ["equals", "contains", "glob"], [], true),
    field("model", "model", "field", "model", ["equals", "starts_with", "glob"]),
    field("litellm.api_key_alias", "litellm", "field", "litellm.api_key_alias", ["equals", "glob"]),
    field("litellm.team_id", "litellm", "field", "litellm.team_id", ["equals", "glob"]),
    field("litellm.user_id", "litellm", "field", "litellm.user_id", ["equals", "glob"]),
    field("a2a.version", "a2a", "field", "a2a.version", ["equals"], ["0.3", "1.0"]),
    field("a2a.extensions", "a2a", "field", "a2a.extensions", ["contains", "glob"]),
    field("a2a.operation", "a2a", "field", "a2a.operation", ["equals", "glob"]),
    field("a2a.context_id", "a2a", "field", "a2a.context_id", ["equals", "glob"]),
    field("a2a.task_id", "a2a", "field", "a2a.task_id", ["equals", "glob"]),
    field("adapter.field", "request", "field", "", ["equals", "contains", "starts_with", "glob"], [], true),
  ];
}

export function assertTrafficScopeSupported(scope: TrafficScope): void {
  const definitions = new Map(trafficScopeFields().map((item) => [item.id, item]));
  let conditionCount = 0;
  const visit = (group: TrafficScope, depth: number, root: boolean) => {
    if (depth > 4) throw new ValidationError("Traffic Scope nesting cannot exceed four levels.");
    if (!root && group.conditions.length === 0) throw new ValidationError("Nested Traffic Scope groups cannot be empty.");
    for (const item of group.conditions) {
      if ("conditions" in item) {
        visit(item, depth + 1, false);
        continue;
      }
      conditionCount += 1;
      if (conditionCount > 16) throw new ValidationError("Traffic Scope cannot contain more than 16 conditions.");
      const definition = definitions.get(item.field);
      if (!definition) throw new ValidationError(`Traffic Scope field ${item.field} is not supported by Runner.`);
      if (!definition.operators.includes(item.operator)) {
        throw new ValidationError(`Operator ${item.operator} is not supported for Traffic Scope field ${item.field}.`);
      }
      if (definition.custom_key && !item.key.trim()) {
        throw new ValidationError(`Traffic Scope field ${item.field} requires a key.`);
      }
      if (!definition.custom_key && item.key.trim()) {
        throw new ValidationError(`Traffic Scope field ${item.field} does not accept a custom key.`);
      }
      if (definition.values.length && !definition.values.includes(item.value)) {
        throw new ValidationError(`Value ${item.value} is not supported for Traffic Scope field ${item.field}.`);
      }
    }
  };
  visit(scope, 1, true);
}

function field(
  id: string,
  group: "request" | "authentication" | "http" | "model" | "litellm" | "a2a",
  source: "field" | "header" | "jwt_claim",
  key: string,
  operators: Array<"equals" | "contains" | "starts_with" | "glob">,
  values: string[] = [],
  customKey = false,
) {
  return { id, group, source, key, operators, values, ...(customKey ? { custom_key: true } : {}) };
}

function runnerAuthentication(token: string): MiddlewareHandler {
  return async (context: Context, next) => {
    if (context.req.header("authorization") !== `Bearer ${token}`) {
      return context.json({ error: { code: "runner_unauthenticated", message: "Runner authentication failed." } }, 401);
    }
    await next();
  };
}

function metricsAuthentication(token: string | null): MiddlewareHandler {
  return async (context: Context, next) => {
    if (token && context.req.header("authorization") !== `Bearer ${token}`) {
      return context.json({ error: { code: "metrics_unauthenticated", message: "Metrics authentication failed." } }, 401);
    }
    await next();
  };
}
