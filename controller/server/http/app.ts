import { openApiDocument, apiReferenceHtml, apiAgentIndex } from "./openapi.js";
import { allowsTokenPermission } from "../../shared/access-tokens.js";
import type { AccessTokenService, TokenIdentity } from "../services/access-tokens.js";
import { requiredTokenPermission } from "./token-permissions.js";
import { routerDraftSchema, previewRouter, selectorFields, selectorFieldCatalog, RoutingEvaluationError, routingInputSchema } from "../../shared/traffic-routing.js";
import { routingEventSchema } from "../services/traffic-routing.js";
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
import { IntentAnalysisError, OpenAICompatibleIntentAnalyzer, type IntentAnalyzer } from "../control-plane-ai/intent-analyzer.js";
import { recommendationCatalog } from "../control-plane-ai/recommendation-catalog.js";
import { ConflictError, ControllerError, NotFoundError, ValidationError } from "../domain/errors.js";
import { enforcementActions } from "../domain/guardrail-plan.js";
import { deriveRunnerFleetStatus } from "../domain/platform-status.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import type { ControllerMetrics } from "../metrics.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { actionCatalog } from "../action-catalog/catalog.js";
import { createProgrammablePolicySchema, updateProgrammablePolicySchema } from "../policy-studio/model.js";
import { extractDocuments } from "../control-plane-ai/document-ingestion.js";
import type { ModelConfigurationService } from "../model-config/service.js";
import { modelAssignmentTargetSchema, modelInputSchema, providerInputSchema, providerRegistrationSchema, providerUpdateSchema } from "../model-config/domain.js";
import {
  OpenAICompatiblePlaygroundModel,
  PlaygroundDraftPreviewStore,
  type RunnerPlaygroundClient,
  runPlaygroundInteraction,
} from "../playground/service.js";
import { isGuardrailVersionId } from "../../shared/guardrail-version.js";
import type { PlatformStatusSnapshot } from "../../shared/platform-status.js";
import { protectionDirectories } from "../../shared/protection-map.js";
import { protectionPresets } from "../../shared/protection-presets.js";
import { expandProtectionPreset } from "../policy-catalog/presets.js";

type Actor = { id: string; role: string; tokenId?: string; permissions?: TokenIdentity["permissions"] };
type Variables = { actor: Actor };
const guardrailVersionInput = z.string().refine(isGuardrailVersionId, "Guardrail Version must be a canonical UTC timestamp.")
  .describe("Immutable Guardrail Version ID in YYYYMMDD-HHmmss.SSSZ UTC format, for example 20260912-083000.123Z. Use a version returned by the API; numeric revisions and ISO date strings are not version IDs.");

const guardrailPolicyBindingInput = z.object({
  policyId: z.string().trim().min(1).max(256),
  policyVersion: z.string().trim().min(1).max(128),
  action: z.enum(enforcementActions).nullable().default(null),
  parameterValues: z.record(z.string(), z.string()).default({}),
  enabledRuleIds: z.array(z.string().min(1)).max(512).default([]),
  ruleActions: z.record(z.string(), z.enum(enforcementActions)).default({}),
  ruleOrder: z.array(z.string()).default([]),
  testCaseOverrides: z.record(z.string(), z.object({
    sourcePolicyVersion: z.string().min(1),
    reason: z.string().trim().min(1).max(2000),
    expectedDecision: z.enum(["allow", "block", "transform", "intervene"]),
    expectedOutputContent: z.string().max(100000).optional(),
    expectedMatches: z.array(z.object({ policyId: z.string().min(1), ruleId: z.string().min(1) })).max(512),
  })).default({}),
  enabledRails: z.array(z.enum(["input", "output", "retrieval", "dialog", "execution"])).default([]),
  reasoningPolicy: z.object({
    policyId: z.string().trim().min(1),
    policyVersion: z.string().trim().min(1),
    confidenceThreshold: z.number().min(0).max(1).default(0.8),
  }).nullable().default(null),
});
const guardrailDraftInput = z.strictObject({
  allowedTopics: z.array(z.string().trim().min(1).max(500)).max(256).default([]),
  restrictedTopics: z.array(z.never()).max(0, "Topic Control is allowlist-only; restricted topics are not accepted.").default([]),
  policyBindings: z.array(guardrailPolicyBindingInput).min(1).max(128),
  safetyLevel: z.enum(["balanced", "strict"]).default("balanced"),
  outputDelivery: z.enum(["interruptible", "window_buffered", "full_buffered"]).default("full_buffered"),
});
const guardrailInput = z.strictObject({
  name: z.string().trim().min(1).max(160),
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
  guardrail_version: guardrailVersionInput,
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
const endpointInput = z.object({
  name: z.string().trim().min(1).max(160),
  adapter: z.string().trim().min(1).max(80),
});
const endpointEnabledInput = z.object({ enabled: z.boolean() });
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
const routerInput = z.object({
  name: z.string().trim().min(1).max(160),
  guardrailId: z.string().min(1),
  endpointId: z.string().min(1),
  poolId: z.string().min(1).default("default"),
  trafficScope: trafficScopeInput.default({ combinator: "and", conditions: [] }),
  enabled: z.boolean().default(true),
});
const routerBindingsInput = routerInput.omit({ endpointId: true }).extend({ endpointIds: z.array(z.string().min(1)).min(1).max(50) });
const routerEnabledInput = z.object({ enabled: z.boolean() });
const routerScopeInput = z.object({ trafficScope: trafficScopeInput });
const routerOrderInput = z.object({ routerIds: z.array(z.string().min(1)).min(1).max(100) });
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
  guardrailVersion: guardrailVersionInput.optional(),
  endpointId: z.string().optional(),
  routerId: z.string().optional(),
  direction: z.enum(["incoming", "outgoing"]),
  decision: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const runtimeEventBatchInput = z.object({
  events: z.array(z.union([routingEventSchema, runtimeEventInput])).max(1_000),
  runnerId: z.string().min(1).optional(),
  observedAt: z.coerce.date().optional(),
}).superRefine((value, context) => {
  if (value.events.length === 0 && !value.runnerId) {
    context.addIssue({ code: "custom", path: ["runnerId"], message: "runnerId is required for an empty telemetry batch." });
  }
});
const modelCredentialRefsInput = z.object({ refs: z.array(z.string().uuid()).max(64), leaseId: z.string().uuid().optional() });

export function createHttpApp(input: {
  config: ControllerConfig;
  auth: ControllerAuth;
  accessTokens?: AccessTokenService;
  service: ControlPlaneService;
  runnerControl: RunnerControlServer;
  metrics: ControllerMetrics;
  models?: ModelConfigurationService | null;
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
  const legacyIntentAnalyzer = input.intentAnalyzer ?? null;
  const legacyPlaygroundModel = input.playgroundModel ?? null;
  const playgroundRunner = input.playgroundRunner ?? null;
  const currentIntentAnalyzer = async () => {
    const configured = await input.models?.controlPlaneModel("policy_authoring");
    return configured ? new OpenAICompatibleIntentAnalyzer(configured) : legacyIntentAnalyzer;
  };
  const currentPlaygroundModel = async () => {
    const configured = await input.models?.controlPlaneModel("playground_chat");
    return configured ? new OpenAICompatiblePlaygroundModel(configured) : legacyPlaygroundModel;
  };
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

  app.get("/api/openapi.json", context => {
    const document = openApiDocument({ module: context.req.query("module"), operationId: context.req.query("operationId") });
    return document ? context.json(document) : context.json({ error: { code: "not_found", message: "API module or operation not found." } }, 404);
  });
  app.get("/api/docs", context => context.html(apiReferenceHtml()));
  app.get("/api/llms.txt", context => context.text(apiAgentIndex()));

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
    const desiredGeneration = await input.service.desiredGeneration();
    const pools = await input.service.listRunnerPoolsWithCapacity();
    const observedAt = new Date();
    const defaultPool = pools.find((pool) => pool.isDefault);
    const { reasons: runnerReasons, ...runnerFleet } = deriveRunnerFleetStatus(defaultPool, {
      observedAt, offlineAfterSeconds: input.config.offlineAfterSeconds, desiredGeneration,
    });
    const configuredProtection = await input.service.defaultGuardrailReadiness();
    const configuredModels = input.models ? await input.models.statusSummary() : {
      controlPlane: {
        status: input.config.modelConnections.controlPlane.model === "not-configured" ? "unconfigured" as const : "configured" as const,
        provider: input.config.modelConnections.controlPlane.model === "not-configured" ? null : input.config.modelConnections.controlPlane.provider,
        model: input.config.modelConnections.controlPlane.model === "not-configured" ? null : input.config.modelConnections.controlPlane.model,
      },
      dataPlane: {
        status: input.config.modelConnections.dataPlane.models.length > 0 ? "configured" as const : "unconfigured" as const,
        ...input.config.modelConnections.dataPlane,
      },
    };
    const assignedBindings = new Set(configuredModels.dataPlane.models.map((model) => model.id));
    const missingBindings = configuredProtection.coverage?.requiredModelBindings.filter((id) => !assignedBindings.has(id)) ?? [];
    const basicProtection = {
      ...configuredProtection,
      status: configuredProtection.status !== "ready" ? configuredProtection.status
        : missingBindings.length || runnerFleet.status === "unavailable" ? "unavailable" as const
          : runnerFleet.servingRunners === 0 ? "initializing" as const : "ready" as const,
    };
    const basicProtectionReason = configuredProtection.status === "initializing"
      ? "default_guardrail_initializing" as const
      : configuredProtection.status === "unavailable"
        ? "default_guardrail_unavailable" as const
        : null;
    const status = basicProtection.status === "unavailable"
      ? "unavailable" as const
      : runnerFleet.status === "unavailable"
        ? "unavailable" as const
        : basicProtection.status === "initializing"
          ? "initializing" as const
          : configuredProtection.coverage?.hasUnknownDependencies && runnerFleet.status === "healthy"
            ? "degraded" as const : runnerFleet.status;
    const reasons: PlatformStatusSnapshot["reasons"] = [
      ...(basicProtectionReason ? [basicProtectionReason] : []),
      ...(missingBindings.length ? ["default_model_bindings_missing" as const] : []),
      ...(configuredProtection.coverage?.hasUnknownDependencies ? ["default_dependencies_unknown" as const] : []),
      ...runnerReasons.filter((reason) => reason !== "all_required_components_ready"),
    ];
    if (reasons.length === 0) reasons.push("all_required_components_ready");
    const snapshot = {
      status,
      reasons,
      observedAt: observedAt.toISOString(),
      desiredGeneration,
      components: {
        controller: { status: "operational" as const },
        basicProtection,
        runnerFleet,
        controlPlaneModel: configuredModels.controlPlane,
        runtimeModels: {
          // Active assignments are configuration evidence, not a live model call.
          status: configuredModels.dataPlane.status,
          provider: configuredModels.dataPlane.provider,
          models: configuredModels.dataPlane.models,
        },
      },
    } satisfies PlatformStatusSnapshot;
    return context.json(snapshot, ["healthy", "degraded"].includes(snapshot.status) ? 200 : 503);
  });

  app.on(["GET", "POST"], "/api/auth/*", (context) => input.auth.handler(context.req.raw));

  const authenticated = authentication(input.auth, input.accessTokens);
  const administrator = authorization("admin");
  const accountSession: MiddlewareHandler<{ Variables: Variables }> = async (context, next) => {
    context.header("Cache-Control", "no-store");
    if (context.get("actor").tokenId) throw new ControllerError("Use your browser session to manage access tokens.", 403, "session_required");
    const origin = context.req.header("origin");
    if (context.req.header("sec-fetch-site") === "cross-site" || (origin && !input.config.trustedOrigins.includes(origin)))
      throw new ControllerError("Untrusted request origin.", 403, "forbidden");
    if (!input.accessTokens) throw new ControllerError("Access tokens are unavailable.", 503, "access_tokens_unavailable");
    await next();
  };
  app.get("/api/v1/account/access-tokens", authenticated, accountSession, async context =>
    context.json({ items: await input.accessTokens!.list(context.get("actor").id) }));
  app.post("/api/v1/account/access-tokens", authenticated, accountSession, async context => {
    if (!context.req.header("content-type")?.toLowerCase().startsWith("application/json"))
      throw new ControllerError("JSON content type is required.", 415, "unsupported_media_type");
    return context.json(await input.accessTokens!.create(context.get("actor").id, await context.req.json()), 201);
  });
  app.delete("/api/v1/account/access-tokens/:id", authenticated, accountSession, async context => {
    await input.accessTokens!.revoke(context.get("actor").id, context.req.param("id"));
    return context.body(null, 204);
  });
  app.get("/api/v1/account/identity", authenticated, context => {
    context.header("Cache-Control", "no-store");
    const actor = context.get("actor");
    return context.json({ userId: actor.id, role: actor.role, authentication: actor.tokenId ? "access_token" : "session",
      tokenId: actor.tokenId ?? null, permissions: actor.permissions ?? null,
      effectivePermissions: actor.permissions ? Object.fromEntries(Object.entries(actor.permissions).map(([module, access]) => [module, actor.role === "admin" ? access : "read"])) : null });
  });


  app.get("/api/v1/model-configuration", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.view());
  });
  app.post("/api/v1/model-providers", authenticated, administrator, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.createProvider(providerInputSchema.parse(await context.req.json()), context.get("actor").id), 201);
  });
  app.patch("/api/v1/model-providers/:id", authenticated, administrator, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.updateProvider(context.req.param("id"), providerUpdateSchema.parse(await context.req.json()), context.get("actor").id));
  });
  app.post("/api/v1/model-provider-discoveries", authenticated, administrator, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.discoverProviderDraft(providerInputSchema.parse(await context.req.json())));
  });
  app.post("/api/v1/model-provider-registrations", authenticated, administrator, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.registerProviderModels(providerRegistrationSchema.parse(await context.req.json()), context.get("actor").id), 201);
  });
  app.post("/api/v1/model-providers/:id/connection-tests", authenticated, administrator, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.revalidateProvider(context.req.param("id"), context.get("actor").id));
  });
  app.post("/api/v1/model-providers/:id/model-discoveries", authenticated, administrator, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.discoverProviderModels(context.req.param("id")));
  });
  app.delete("/api/v1/model-providers/:id", authenticated, administrator, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    await input.models.deleteProvider(context.req.param("id"), context.get("actor").id);
    return context.body(null, 204);
  });
  app.post("/api/v1/models", authenticated, administrator, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.createModel(modelInputSchema.parse(await context.req.json()), context.get("actor").id), 201);
  });
  app.post("/api/v1/models/:id/capability-tests", authenticated, administrator, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.revalidateModel(context.req.param("id"), context.get("actor").id));
  });
  app.post("/api/v1/models/:id/connection-tests", authenticated, administrator, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.testModelConnection(context.req.param("id"), context.get("actor").id));
  });
  app.put("/api/v1/models/:id/protocol", authenticated, administrator, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.configureModel(context.req.param("id"), await context.req.json(), context.get("actor").id));
  });
  app.delete("/api/v1/models/:id", authenticated, administrator, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    await input.models.deleteModel(context.req.param("id"), context.get("actor").id);
    return context.body(null, 204);
  });
  app.put("/api/v1/model-configuration/draft", authenticated, administrator, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.updateDraft(await context.req.json(), context.get("actor").id));
  });
  app.put("/api/v1/model-configuration/draft/assignments/:target", authenticated, administrator, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    const target = modelAssignmentTargetSchema.parse(context.req.param("target"));
    const body = z.object({ modelId: z.string().uuid().nullable(), validationId: z.string().uuid().optional() }).parse(await context.req.json());
    return context.json(await input.models.updateAssignment(target, body.modelId, context.get("actor").id, body.validationId));
  });
  app.post("/api/v1/model-configuration/draft/assignments/:target/validations", authenticated, administrator, async context => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    const target = modelAssignmentTargetSchema.parse(context.req.param("target"));
    return context.json(await input.models.validateAssignment(target, context.get("actor").id));
  });
  app.post("/api/v1/model-configuration/draft/assignments/:target/candidate-validations", authenticated, administrator, async context => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    const target = modelAssignmentTargetSchema.parse(context.req.param("target"));
    const body = z.object({ modelId: z.string().uuid() }).parse(await context.req.json());
    return context.json(await input.models.previewAssignment(target, body.modelId, context.get("actor").id), 201);
  });
  app.get("/api/v1/model-configuration/draft/assignments/:target/candidate-validations/:validationId", authenticated, async context => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    const target = modelAssignmentTargetSchema.parse(context.req.param("target"));
    return context.json(await input.models.getAssignmentValidation(target, context.req.param("validationId"), context.get("actor").id));
  });
  app.post("/api/v1/model-configuration/draft/validations", authenticated, administrator, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.validateDraft(context.get("actor").id));
  });
  app.post("/api/v1/model-configuration/revisions/:id/activate", authenticated, administrator, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    const revision = await input.models.beginActivation(context.req.param("id"), context.get("actor").id);
    const distribution = await input.runnerControl.distributeDesiredState("default", 10_000);
    if (distribution.distributionStatus === "ready") await input.models.finalizeActivation(revision.id);
    const view = await input.models.view();
    if (view.failed?.id === revision.id) {
      throw new ConflictError(view.failed.failureReason || "Runner rejected the Model configuration.", "model_configuration_runner_rejected");
    }
    return context.json({ ...view, distribution }, distribution.distributionStatus === "ready" ? 200 : 202);
  });
  app.post("/api/v1/model-configuration/rollback", authenticated, administrator, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    const body = z.object({ targetRevisionId: z.string().uuid() }).parse(await context.req.json());
    const revision = await input.models.rollback(context.get("actor").id, body.targetRevisionId);
    const distribution = await input.runnerControl.distributeDesiredState("default", 10_000);
    if (distribution.distributionStatus === "ready") await input.models.finalizeActivation(revision.id);
    const view = await input.models.view();
    if (view.failed?.id === revision.id) {
      throw new ConflictError(view.failed.failureReason || "Runner rejected the rollback Model configuration.", "model_configuration_runner_rejected");
    }
    return context.json({ ...view, distribution }, distribution.distributionStatus === "ready" ? 200 : 202);
  });

  app.get("/api/v1/policies", authenticated, async (context) => {
    const items = await input.service.listPolicies();
    return context.json({ items, count: items.length });
  });
  app.get("/api/v1/policy-catalog/protection-presets", authenticated, (context) => {
    const policies = policyCatalog.list();
    const items = protectionPresets.map((preset) => ({ ...preset, policyBindings: expandProtectionPreset(preset, policies) }));
    // This is a preview, not a save/activation or evidence that runtime checks passed.
    return context.json({ directories: protectionDirectories, items, count: items.length });
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
  app.get("/api/v1/policies/:id/draft/checks", authenticated, async (context) => {
    return context.json(await input.service.validatePolicy(context.req.param("id")));
  });
  app.get("/api/v1/policies/:id/validation-runs/latest", authenticated, async (context) => {
    return context.json(await input.service.latestPolicyValidation(context.req.param("id")));
  });
  app.get("/api/v1/policies/:id/validation-runs/:runId", authenticated, async context =>
    context.json(await input.service.getPolicyValidation(context.req.param("id"), context.req.param("runId"))));
  app.post("/api/v1/policies/:id/validation-runs", authenticated, administrator, async (context) => {
    const run = await input.service.requestPolicyValidation({
      id: context.req.param("id"), actorId: context.get("actor").id,
      compilerAvailable: input.runnerControl.hasDefaultCompiler(),
    });
    const statusUrl = `/api/v1/policies/${encodeURIComponent(context.req.param("id"))}/validation-runs/${encodeURIComponent(run.id)}`;
    context.header("Location", statusUrl);
    return context.json({ ...run, statusUrl }, 202);
  });
  app.post("/api/v1/policies/:id/publish", authenticated, administrator, async (context) => {
    const body = await context.req.text();
    const request = z.object({ expectedDraftRevision: z.number().int().positive() }).parse(body ? JSON.parse(body) : {});
    return context.json(await input.service.publishPolicy({ id: context.req.param("id"), actorId: context.get("actor").id,
      ...(request.expectedDraftRevision === undefined ? {} : { expectedDraftRevision: request.expectedDraftRevision }),
    }), 201);
  });
  app.get("/api/v1/policy-catalog/actions", authenticated, (context) => {
    const items = actionCatalog();
    return context.json({ items, count: items.length });
  });

  app.get("/api/v1/authoring/capabilities", authenticated, async (context) => {
    const analyzer = await currentIntentAnalyzer();
    return context.json({
      available: analyzer !== null,
      provider: analyzer?.provider ?? null,
      model: analyzer?.model ?? null,
      document_analysis_available: analyzer !== null,
    });
  });
  app.post("/api/v1/authoring/intent-analyses", authenticated, administrator, async (context) => {
    const intentAnalyzer = await currentIntentAnalyzer();
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
  app.post("/api/v1/authoring/document-analyses", authenticated, administrator, async (context) => {
    const intentAnalyzer = await currentIntentAnalyzer();
    if (!intentAnalyzer) {
      throw new ControllerError("The control-plane assistant is not configured.", 503, "intent_analysis_unavailable");
    }
    const form = await context.req.formData();
    const language = form.get("language") === "zh-CN" ? "zh-CN" : "en";
    const files = form.getAll("files").filter((item): item is File => item instanceof File);
    const documents = await extractDocuments(files);
    const policies = recommendationCatalog(await input.service.listPolicies());
    const analysis = await intentAnalyzer.analyzeDocuments({ documents, policies, language });
    const allowedIds = new Set(policies.map((policy) => policy.id));
    if (analysis.recommended_policy_ids.some((id) => !allowedIds.has(id))) {
      throw new IntentAnalysisError("The control-plane assistant recommended a Policy outside the current selectable catalog. Retry the analysis.");
    }
    return context.json({
      ...analysis,
      sources: documents.map(({ sections: _sections, ...source }) => source),
    });
  });

  app.get("/api/v1/guardrails", authenticated, async (context) => context.json({ items: await input.service.listGuardrails() }));
  app.get("/api/v1/playground/models", authenticated, async (context) => {
    const playgroundModel = await currentPlaygroundModel();
    const items = playgroundModel ? [playgroundModel.descriptor] : [];
    return context.json({ items, count: items.length });
  });
  app.post("/api/v1/playground/guardrails/:guardrailId/draft-previews", authenticated, administrator, async (context) => {
    const playgroundModel = await currentPlaygroundModel();
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
  app.post("/api/v1/playground/guardrails/:guardrailId/draft-interactions", authenticated, administrator, async (context) => {
    const playgroundModel = await currentPlaygroundModel();
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
  app.post("/api/v1/playground/guardrails/:guardrailId/interactions", authenticated, async (context) => {
    const playgroundModel = await currentPlaygroundModel();
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
  app.post("/api/v1/authoring/plan-previews", authenticated, administrator, async (context) => {
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
  app.post("/api/v1/guardrails/:id/duplicate", authenticated, administrator, async context => {
    const body = z.object({ name: z.string().trim().min(1).max(160), sourceVersion: guardrailVersionInput.optional(), sourceDraftRevision: z.number().int().positive().optional(), idempotencyKey: z.string().min(1).max(128) })
      .refine(value => !(value.sourceVersion && value.sourceDraftRevision), "Choose one copy source").parse(await context.req.json());
    return context.json(await input.service.duplicateGuardrail({ ...body, id: context.req.param("id"), actorId: context.get("actor").id }), 201);
  });
  app.patch("/api/v1/guardrails/:id", authenticated, administrator, async (context) => {
    const body = guardrailUpdateInput.parse(await context.req.json());
    return context.json(await input.service.updateGuardrail({
      id: context.req.param("id"), actorId: context.get("actor").id, ...body,
    }));
  });
  app.post("/api/v1/guardrails/:id/publish", authenticated, administrator, async (context) => {
    const body = z.object({ expectedDraftRevision: z.number().int().positive() }).parse(await context.req.json());
    return context.json(await input.service.requestGuardrailPublish({
      expectedDraftRevision: body.expectedDraftRevision,
      guardrailId: context.req.param("id"),
      actorId: context.get("actor").id,
      compilerAvailable: input.runnerControl.hasDefaultCompiler(),
    }), 202);
  });
  app.delete("/api/v1/guardrails/:id/versions/:version", authenticated, administrator, async context => {
    await input.service.deleteGuardrailVersion({ guardrailId: context.req.param("id"), version: guardrailVersionInput.parse(context.req.param("version")), actorId: context.get("actor").id });
    return context.body(null, 204);
  });
  app.post("/api/v1/guardrails/:id/rollback", authenticated, administrator, async (context) => {
    const { version } = z.object({ version: guardrailVersionInput }).parse(await context.req.json());
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

  app.get("/api/v1/guardrails/:guardrailId/test-cases", authenticated, async (context) => {
    const guardrailId = context.req.param("guardrailId");
    const items = await input.service.listTestCases(guardrailId);
    return context.json({ items, count: items.length });
  });
  app.post("/api/v1/guardrails/:guardrailId/test-cases", authenticated, administrator, async (context) => {
    const body = testCaseInput.omit({ guardrailId: true }).parse(await context.req.json());
    return context.json(await input.service.createTestCase({ ...body, guardrailId: context.req.param("guardrailId"), actorId: context.get("actor").id }), 201);
  });
  app.delete("/api/v1/guardrails/:guardrailId/test-cases/:caseId", authenticated, administrator, async (context) => {
    await input.service.deleteTestCase({ guardrailId: context.req.param("guardrailId"), caseId: context.req.param("caseId"), actorId: context.get("actor").id });
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
  app.post("/api/v1/guardrails/:guardrailId/validation-runs", authenticated, administrator, async (context) => {
    return context.json(await input.service.requestValidation({
      guardrailId: context.req.param("guardrailId"),
      actorId: context.get("actor").id,
      compilerAvailable: input.runnerControl.hasDefaultCompiler(),
    }), 202);
  });

  app.get("/api/v1/endpoints", authenticated, async (context) => {
    const [items, distribution] = await Promise.all([
      input.service.listEndpoints(),
      input.runnerControl.distributionStatus(),
    ]);
    return context.json({ items: items.map((item) => ({ ...item, ...distribution })) });
  });
  app.post("/api/v1/endpoints", authenticated, administrator, async (context) => {
    const body = endpointInput.parse(await context.req.json());
    const created = await input.service.createEndpoint({ ...body, actorId: context.get("actor").id });
    return context.json(await withDistribution(created, true), 201);
  });
  app.get("/api/v1/endpoints/:id", authenticated, async (context) => {
    return context.json(await withDistribution(await input.service.getEndpoint(context.req.param("id"))));
  });
  app.patch("/api/v1/endpoints/:id", authenticated, administrator, async (context) => {
    const body = endpointEnabledInput.parse(await context.req.json());
    const updated = await input.service.setEndpointEnabled({
      id: context.req.param("id"),
      enabled: body.enabled,
      actorId: context.get("actor").id,
    });
    return context.json(await withDistribution(updated, true));
  });
  app.post("/api/v1/endpoints/:id/credentials", authenticated, administrator, async (context) => {
    const updated = await input.service.rotateEndpointCredential({
      id: context.req.param("id"),
      actorId: context.get("actor").id,
    });
    return context.json(await withDistribution(updated, true), 201);
  });
  app.delete("/api/v1/endpoints/:id/credentials/:credentialId", authenticated, administrator, async (context) => {
    await input.service.revokeEndpointCredential({
      id: context.req.param("id"),
      credentialId: context.req.param("credentialId"),
      actorId: context.get("actor").id,
    });
    await input.runnerControl.distributeDesiredState();
    return context.body(null, 204);
  });
  app.get("/api/v1/endpoints/:id/deletion-impact", authenticated, administrator, async (context) => {
    return context.json(await input.service.endpointDeletionImpact(context.req.param("id")));
  });
  app.delete("/api/v1/endpoints/:id", authenticated, administrator, async (context) => {
    const body = deletionInput.parse(await context.req.json());
    await input.service.softDeleteEndpoint({ id: context.req.param("id"), actorId: context.get("actor").id, ...body });
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
  app.get("/api/v1/routers", authenticated, async context => {
    const items = await input.service.trafficRouting.list();
    return context.json({ items, count: items.length });
  });
  app.get("/api/v1/routers/:id", authenticated, async context => context.json(await input.service.trafficRouting.get(context.req.param("id"))));
  app.post("/api/v1/routers", authenticated, administrator, async context => {
    const body = z.object({ name: z.string().trim().min(1).max(160), description: z.string().max(2000).default(""), endpointIds: z.array(z.string().min(1)).max(128).default([]), draft: routerDraftSchema }).parse(await context.req.json());
    return context.json(await input.service.trafficRouting.create(body.name, body.description, body.draft, context.get("actor").id, body.endpointIds), 201);
  });
  app.put("/api/v1/routers/:id/draft", authenticated, administrator, async context => {
    const body = z.object({ expectedDraftRevision: z.number().int().positive(), draft: routerDraftSchema }).parse(await context.req.json());
    return context.json(await input.service.trafficRouting.save(context.req.param("id"), body.expectedDraftRevision, body.draft, context.get("actor").id));
  });
  app.delete("/api/v1/routers/:id", authenticated, administrator, async context => {
    await input.service.trafficRouting.remove(context.req.param("id"), context.get("actor").id);
    await input.runnerControl.distributeDesiredState();
    return context.body(null, 204);
  });
  app.post("/api/v1/routers/:id/publication-preview", authenticated, administrator, async context => {
    const body = z.object({ expectedDraftRevision: z.number().int().positive() }).parse(await context.req.json());
    return context.json(await input.service.trafficRouting.preview(context.req.param("id"), body.expectedDraftRevision));
  });
  app.post("/api/v1/routers/:id/publish", authenticated, administrator, async context => {
    const body = z.object({ expectedDraftRevision: z.number().int().positive(), idempotencyKey: z.string().min(1).max(128), reviewedSnapshot: routerDraftSchema.optional(), reviewedEndpointIds: z.array(z.string().min(1).max(256)).max(10000).optional() }).parse(await context.req.json());
    const result = await input.service.trafficRouting.publish(context.req.param("id"), body.expectedDraftRevision, body.idempotencyKey, context.get("actor").id, undefined, body.reviewedSnapshot, body.reviewedEndpointIds);
    if (!result.publication.replayed) await input.runnerControl.distributeDesiredState();
    return context.json(result, 202);
  });
  app.delete("/api/v1/routers/:id/revisions/:revision", authenticated, administrator, async context => {
    await input.service.trafficRouting.deleteRevision(context.req.param("id"), z.coerce.number().int().positive().parse(context.req.param("revision")), context.get("actor").id);
    return context.body(null, 204);
  });
  app.post("/api/v1/routers/:id/rollback", authenticated, administrator, async context => {
    const body = z.object({ expectedDraftRevision: z.number().int().positive(), idempotencyKey: z.string().min(1).max(128), revision: z.number().int().positive() }).parse(await context.req.json());
    const result = await input.service.trafficRouting.publish(context.req.param("id"), body.expectedDraftRevision, body.idempotencyKey, context.get("actor").id, body.revision);
    if (!result.publication.replayed) await input.runnerControl.distributeDesiredState();
    return context.json(result, 202);
  });
  app.put("/api/v1/routers/:id/endpoints", authenticated, administrator, async context => {
    const body = z.object({ endpointIds: z.array(z.string().min(1)).max(128) }).parse(await context.req.json());
    const result = await input.service.trafficRouting.bind(context.req.param("id"), body.endpointIds, context.get("actor").id);
    if (result.changed) await input.runnerControl.distributeDesiredState();
    return context.json(result);
  });
  app.get("/api/v1/routers/:id/revisions", authenticated, async context => context.json({ items: await input.service.trafficRouting.revisions(context.req.param("id")) }));
  app.get("/api/v1/routers/:id/revisions/:revision", authenticated, async context => {
    const revision = z.coerce.number().int().positive().parse(context.req.param("revision"));
    const record = (await input.service.trafficRouting.revisions(context.req.param("id"))).find(item => item.revision === revision);
    if (!record) throw new NotFoundError("Router revision", String(revision));
    return context.json(record);
  });
  const distributionQuery = z.object({ hours: z.coerce.number().min(0.25).max(168).default(24), revision: z.coerce.number().int().positive().optional(), endpointId: z.string().min(1).optional() });
  app.get("/api/v1/routers/:id/traffic-distribution", authenticated, async context => {
    const q = distributionQuery.parse(context.req.query());
    return context.json(await input.service.trafficRouting.distribution(context.req.param("id"), q.hours, q.revision, q.endpointId));
  });
  app.get("/api/v1/routers/:id/routes/:routeId/traffic-distribution", authenticated, async context => {
    const q = distributionQuery.parse(context.req.query());
    const result = await input.service.trafficRouting.distribution(context.req.param("id"), q.hours, q.revision, q.endpointId);
    return context.json({ ...result, rows: result.rows.filter(row => row.routeId === context.req.param("routeId")) });
  });
  app.post("/api/v1/routers/:id/simulations", authenticated, async context => {
    await input.service.trafficRouting.get(context.req.param("id"));
    const body = z.object({ draft: routerDraftSchema, input: routingInputSchema }).parse(await context.req.json());
    return context.json({ items: previewRouter(body.draft, body.input), simulation: true, normalizedInput: body.input });
  });
  app.get("/api/v1/routing/selector-fields", authenticated, async context => {
    const endpointIds = context.req.query("endpointIds")?.split(",").filter(Boolean);
    const all = await input.service.listEndpoints();
    const selected = endpointIds ? all.filter(e => endpointIds.includes(e.id)) : all;
    const items = selectorFieldCatalog(selected);
    return context.json({ items, endpoints: selected.map(e => ({ id: e.id, adapter: e.adapter })), count: items.length });
  });

  app.get("/api/v1/telemetry/events", authenticated, async (context) => {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(10_000).default(100),
      guardrailId: z.string().min(1).optional(),
      routerId: z.string().min(1).optional(),
      routeId: z.string().min(1).optional(),
      targetId: z.string().min(1).optional(),
      routerRevision: z.coerce.number().int().positive().optional(),
      endpointId: z.string().min(1).optional(),
      since: z.coerce.date().optional(),
      before: z.coerce.date().optional(),
      cursor: z.string().max(2048).optional(),
      requestId: z.string().max(256).optional(),
      direction: z.enum(['incoming','outgoing']).optional(),
      outcome: z.enum(['allow','block','transform','error']).optional(),
      captured: z.enum(['true']).transform(() => true).optional(),
      findingsOnly: z.enum(['true']).transform(() => true).optional(),
      severity: z.enum(['critical','high','medium','low']).optional(),
    }).parse(context.req.query());
    return context.json(await input.service.queryRuntimeEvents(query));
  });
  app.get('/api/v1/telemetry/events/:id', authenticated, async context => context.json(await input.service.getRuntimeEvent(context.req.param('id'), context.get('actor').role === 'admin')));
  app.get('/api/v1/telemetry/endpoint-activity', authenticated, async context => context.json(await input.service.runtimeEndpointActivity()));
  app.get('/api/v1/telemetry/metrics', authenticated, async context => {
    const scope = z.object({ window: z.enum(['1h','24h','7d','15d','30d']).default('24h'), guardrailId:z.string().max(256).optional(), routerId:z.string().max(256).optional() }).parse(context.req.query());
    return context.json(await input.service.runtimeMetrics(scope));
  });
  app.get("/api/v1/audit-events", authenticated, async (context) => {
    const limit = z.coerce.number().int().min(1).max(500).default(100).parse(context.req.query("limit"));
    return context.json({ items: await input.service.listAuditEvents(limit) });
  });

  app.post("/api/internal/v1/runtime-events", runnerAuthentication(input.config.runnerToken), async (context) => {
    const body = runtimeEventBatchInput.parse(await context.req.json());
    try {
      const routing = body.events.filter(event => "eventType" in event);
      const runtime = body.events.filter(event => "requestId" in event);
      if (routing.length) await input.service.trafficRouting.recordEvents(routing);
      await input.service.recordRuntimeEvents(runtime);
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
  app.post("/api/internal/v1/model-credentials/resolve", runnerAuthentication(input.config.runnerToken), async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    const body = modelCredentialRefsInput.parse(await context.req.json());
    return context.json({ credentials: await input.models.resolveCredentials(body.refs, body.leaseId) });
  });

  app.notFound((context) => {
    if (context.req.path.startsWith("/api/") || context.req.path.startsWith("/health/")) {
      return context.json({ error: { code: "not_found", message: "Route not found." } }, 404);
    }
    return context.notFound();
  });
  app.onError((error, context) => {
    if (error instanceof SyntaxError) return context.json({ error: { code: "invalid_json", message: "Request body must be valid JSON." } }, 400);
    if (error instanceof RoutingEvaluationError) return context.json({ error: { code: error.code, message: error.message } }, 422);
    if (error instanceof ControllerError) {
      return context.json({ error: { code: error.code, message: error.message, detail: error.detail } }, error.status as 400);
    }
    if (error instanceof z.ZodError) {
      return context.json({ error: { code: "invalid_request", message: "Request validation failed.", detail: error.flatten() } }, 400);
    }
    console.error(error);
    return context.json({ error: { code: "internal_error", message: "Internal Controller error." } }, 500);
  });

  // Unknown API paths must never fall through to the SPA HTML response.
  app.all("/api/*", context => context.json({ error: { code: "not_found", message: "API operation not found." } }, 404));
  const uiRoot = resolve(input.config.uiDist);
  if (existsSync(uiRoot)) {
    app.use("/assets/*", serveStatic({ root: uiRoot }));
    app.get("/favicon.ico", serveStatic({ root: uiRoot, path: "favicon.ico" }));
    app.get("*", serveStatic({ root: uiRoot, path: "index.html" }));
  }
  return app;
}

function authentication(auth: ControllerAuth, tokens?: AccessTokenService): MiddlewareHandler<{ Variables: Variables }> {
  return async (context, next) => {
    const authorizationHeader = context.req.header("authorization");
    if (authorizationHeader !== undefined) {
      // An explicit credential never falls back to a browser session.
      context.header("Cache-Control", "no-store");
      const match = /^Bearer ([^\s]+)$/i.exec(authorizationHeader);
      const actor = match && tokens ? await tokens.authenticate(match[1]!) : null;
      if (!actor) {
        context.header("WWW-Authenticate", "Bearer");
        return context.json({ error: { code: "unauthenticated", message: "Access token is invalid, expired, or revoked." } }, 401);
      }
      const permission = requiredTokenPermission(context.req.method, context.req.path);
      if (context.req.path !== "/api/v1/account/identity" || context.req.method !== "GET") {
        if (!permission || !allowsTokenPermission(actor.permissions, permission[2], permission[3], actor.role))
          return context.json({ error: { code: "insufficient_token_permission", message: "This token does not allow the requested operation." } }, 403);
      }
      context.set("actor", actor);
      await next();
      if (!["GET", "HEAD"].includes(context.req.method))
        await tokens!.recordRequest(actor, context.req.method, permission![1], context.res.status);
      return;
    }
    // Cookie-cached identity is suitable for rendering the shell, not for API
    // authority: revocation, expiry and role changes must use current DB state.
    const session = await auth.api.getSession({
      headers: context.req.raw.headers,
      query: { disableCookieCache: true },
    });
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
    field("endpoint.id", "authentication", "field", "endpoint.id", ["equals"]),
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
