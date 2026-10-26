import { hasPermission, isAccountRole } from "../../shared/rbac.js";
import { modelReadiness } from "../../shared/model-readiness.js";
import { pricingRuleSchema, costQuerySchema } from "../../shared/model-pricing.js";
import { protectionModes } from "../../shared/protection-mode.js";
import { formalValidationSchema } from "../../shared/formal-validation.js";
import { testingReportsQuery } from "../services/testing-reports.js";
import { runtimeLogOutcomes } from "../../shared/runtime-outcome.js";
import { readSoftwareVersion } from "../services/software-version.js";
import { parseSoftwareVersion } from "../../shared/software-version.js";
import { auditQuerySchema } from "../../shared/audit-query.js";
import { pathTestSchema, parseHttpRequest, requestSource } from "../../shared/playground-path.js";
import { openApiDocument, apiReferenceHtml, apiAgentIndex } from "./openapi.js";
import { allowsTokenPermission, effectiveTokenPermissions } from "../../shared/access-tokens.js";
import type { AccessTokenService, TokenIdentity } from "../services/access-tokens.js";
import { requiredAccountPermission, requiredTokenPermission } from "./token-permissions.js";
import { partialModelActivationSchema } from "../../shared/model-activation.js";
import { routerDraftSchema, previewRouter, selectorFields, selectableSelectorFields, RoutingEvaluationError, routingInputSchema } from "../../shared/traffic-routing.js";
import { routingEventSchema } from "../services/traffic-routing.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { serveStatic } from "@hono/node-server/serve-static";
import { prometheus } from "@hono/prometheus";
import { securityEventsQuery } from "../../shared/security-events.js";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { policyDefinitionSchema } from "../../shared/policy-definition.js";
import { publicPolicy } from "../policy-catalog/public-policy.js";

import type { ControllerAuth } from "../auth.js";
import type { ControllerConfig } from "../config.js";
import { IntentAnalysisError, OpenAICompatibleIntentAnalyzer, type IntentAnalyzer } from "../control-plane-ai/intent-analyzer.js";
import { recommendationCatalog } from "../control-plane-ai/recommendation-catalog.js";
import { ConflictError, ControllerError, NotFoundError, ValidationError } from "../domain/errors.js";
import { enforcementActions } from "../domain/guardrail-plan.js";
import { deriveRunnerFleetStatus } from "../domain/platform-status.js";
import { deriveComponentHealth, withModelHealth } from "../domain/component-health.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import { endpointSetup, type ControlPlaneService } from "../services/control-plane.js";
import { endpointRequestOrigin } from "./endpoint-origin.js";
import type { ControllerMetrics } from "../metrics.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { actionCatalog } from "../action-catalog/catalog.js";
import { createProgrammablePolicySchema, updateProgrammablePolicySchema } from "../policy-studio/model.js";
import { extractDocuments } from "../control-plane-ai/document-ingestion.js";
import { PACKAGE_UPLOAD_LIMIT_BYTES } from "../domain/guardrail-package.js";
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

type Actor = { id: string; role: string; tokenId?: string; permissions?: TokenIdentity["permissions"] };
type Variables = { actor: Actor };
const packageVersionsQuery = z.string().max(4_000).optional()
  .transform(value => value?.split(",").map(item => item.trim()).filter(Boolean) ?? [])
  .pipe(z.array(z.string().refine(isGuardrailVersionId, "Guardrail Version must be a canonical UTC timestamp.")).max(64));
const packageImportInput = z.object({ versions: z.array(z.string().refine(isGuardrailVersionId, "Guardrail Version must be a canonical UTC timestamp.")).max(64).optional(), restoreDeleted: z.boolean().optional() });
// Multipart framing adds a little to the archive itself.
const packageUploadLimit = bodyLimit({ maxSize: PACKAGE_UPLOAD_LIMIT_BYTES + 64 * 1024, onError: () => {
  throw new ControllerError("The package exceeds the 32 MiB upload limit.", 413, "guardrail_package_too_large");
} });
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
  profileOrigin: z.object({ id: z.string().trim().min(1).max(256), version: z.string().trim().min(1).max(128) }).optional(),
  allowedTopics: z.array(z.string().trim().min(1).max(500)).max(256).default([]),
  restrictedTopics: z.array(z.string().trim().min(1).max(500)).max(256).default([]),
  topicControlMode: z.enum(["strict", "permissive"]).default("permissive"),
  policyBindings: z.array(guardrailPolicyBindingInput).min(1).max(128),
  safetyLevel: z.enum(["balanced", "strict"]).default("balanced"),
  outputDelivery: z.enum(["interruptible", "window_buffered", "full_buffered"]).default("full_buffered"),
});
const guardrailInput = z.strictObject({
  name: z.string().trim().min(1).max(160),
  draftConfig: guardrailDraftInput,
  runtimeProfile: z.enum(["auto", "llmrails_colang1_standard", "llmrails_colang2_programmable", "iorails_native"]).default("auto"),
});
const guardrailUpdateInput = guardrailInput.partial().extend({ expectedDraftRevision: z.number().int().positive().optional() });
const intentAnalysisInput = z.object({
  purpose: z.string().trim().min(1).max(2_000),
  deniedPurpose: z.string().trim().min(1).max(2_000).optional(),
  topicControlMode: z.enum(["strict", "permissive"]).default("permissive"),
  language: z.enum(["en", "zh-CN"]).default("en"),
});
// Router change justification, rejection note or emergency reason.
const changeReason = z.string().trim().min(1).max(2000);
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
const validationTestOptions = z.object({ testModelRules: z.boolean().default(true) }).strict();
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
  adapter: z.enum(["litellm-generic-guardrail", "f5-scan"]),
  scanFlagOnlyDefault: z.boolean().optional().describe("F5 Scan only. Default for requests that omit flagOnly; new Endpoints default to true. Explicit request values take precedence."),
});
const endpointUpdateInput = z.object({
  enabled: z.boolean().optional(),
  scanFlagOnlyDefault: z.boolean().optional().describe("F5 Scan only. Default for requests that omit flagOnly. Explicit request values take precedence."),
}).strict().refine(value => value.enabled !== undefined || value.scanFlagOnlyDefault !== undefined, "Provide enabled or scanFlagOnlyDefault.");
const deletionInput = z.object({
  reason: z.string().trim().min(1).max(1_000),
  confirmRecentTraffic: z.boolean().default(false),
  confirmationName: z.string().trim().max(160).optional(),
});
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
  const controllerVersion = readSoftwareVersion();
  // Fail fast on a broken Library.
  PolicyCatalog.load(input.config.policyCatalogDir);
  const legacyIntentAnalyzer = input.intentAnalyzer ?? null;
  const legacyPlaygroundModel = input.playgroundModel ?? null;
  const playgroundRunner = input.playgroundRunner ?? null;
  const currentIntentAnalyzer = async () => {
    const configured = await input.models?.controlPlaneModel("policy_authoring");
    // Authoring produces full structured proposals, unlike short model probes.
    return configured ? new OpenAICompatibleIntentAnalyzer({ ...configured, timeoutMs: Math.max(configured.timeoutMs, 60_000) }) : legacyIntentAnalyzer;
  };
  const currentPlaygroundModel = async () => {
    const configured = await input.models?.controlPlaneModel("playground_chat");
    return configured ? new OpenAICompatiblePlaygroundModel(configured) : legacyPlaygroundModel;
  };
  const playgroundDraftPreviews = new PlaygroundDraftPreviewStore();
  const withEndpointSetup = <T extends { id: string; adapter: string }>(resource: T, context: Context) => ({
    ...resource,
    setup: endpointSetup(input.config.runtimePublicUrl ?? endpointRequestOrigin(context.req.raw), resource.id, resource.adapter),
  });
  const withDistribution = async <T extends { id: string; adapter: string }>(resource: T, context: Context, wait = false) => ({
    ...withEndpointSetup(resource, context),
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
  // File import/export is always available; no deployment-specific setup.
  app.get("/api/v1/deployment/capabilities", context => context.json({
    packageExport: { available: true, sourceId: null },
    packageImport: { available: true },
  }));
  app.get("/api/v1/system/status", async (context) => {
    const desiredGeneration = await input.service.desiredGeneration();
    const pools = await input.service.listRunnerPoolsWithCapacity();
    const observedAt = new Date();
    const defaultPool = pools.find((pool) => pool.isDefault);
    const { reasons: runnerReasons, ...runnerFleet } = deriveRunnerFleetStatus(defaultPool, {
      observedAt, offlineAfterSeconds: input.config.offlineAfterSeconds, desiredGeneration,
    });
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
    const modelHealth = input.models ? await input.models.modelHealth(await input.service.requiredPlatformModelBindings()) : null;
    const status = modelHealth && modelHealth.status !== "healthy" ? "unavailable" as const : runnerFleet.status;
    const reasons: PlatformStatusSnapshot["reasons"] = [
      ...(modelHealth?.reason === "configuration_required" ? ["required_model_bindings_missing" as const] : []),
      ...(modelHealth?.reason === "validation_required" ? ["model_validation_required" as const] : []),
      ...runnerReasons.filter(reason => reason !== "all_required_components_ready"),
    ];
    if (reasons.length === 0) reasons.push("all_required_components_ready");
    const snapshot = {
      status,
      reasons,
      observedAt: observedAt.toISOString(),
      desiredGeneration,
      components: {
        controller: { status: "operational" as const },
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
      effectivePermissions: actor.permissions ? effectiveTokenPermissions(actor.permissions, actor.role) : null });
  });


  app.get("/api/v1/model-pricing", authenticated, async context => context.json(await input.service.pricing.view()));
  app.get("/api/v1/model-pricing/catalog", authenticated, async context => {
    const query = z.object({ q: z.string().trim().min(2).max(256) }).parse(context.req.query());
    return context.json(await input.service.pricing.catalog(query.q));
  });
  app.put("/api/v1/models/:id/pricing", authenticated, async context => {
    const body = pricingRuleSchema.parse(await context.req.json());
    return context.json(await input.service.pricing.configure(context.req.param("id"), body, context.get("actor").id));
  });
  app.get("/api/v1/guardrails/:id/usage-costs", authenticated, async context => {
    const query = costQuerySchema.parse(context.req.query());
    return context.json(await input.service.pricing.guardrailUsage(context.req.param("id"), query));
  });

  app.get("/api/v1/model-configuration", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.view());
  });
  app.post("/api/v1/model-providers", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.createProvider(providerInputSchema.parse(await context.req.json()), context.get("actor").id), 201);
  });
  app.patch("/api/v1/model-providers/:id", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.updateProvider(context.req.param("id"), providerUpdateSchema.parse(await context.req.json()), context.get("actor").id));
  });
  app.post("/api/v1/model-provider-discoveries", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.discoverProviderDraft(providerInputSchema.parse(await context.req.json())));
  });
  app.post("/api/v1/model-provider-registrations", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.registerProviderModels(providerRegistrationSchema.parse(await context.req.json()), context.get("actor").id), 201);
  });
  app.post("/api/v1/model-providers/:id/connection-tests", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.revalidateProvider(context.req.param("id"), context.get("actor").id));
  });
  app.post("/api/v1/model-providers/:id/model-discoveries", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.discoverProviderModels(context.req.param("id")));
  });
  app.delete("/api/v1/model-providers/:id", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    await input.models.deleteProvider(context.req.param("id"), context.get("actor").id);
    return context.body(null, 204);
  });
  app.get("/api/v1/model-providers", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    const view = await input.models.view();
    return context.json(view.providers);
  });
  app.get("/api/v1/models", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    const view = await input.models.view();
    return context.json(view.models);
  });
  app.post("/api/v1/models", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.createModel(modelInputSchema.parse(await context.req.json()), context.get("actor").id), 201);
  });
  app.post("/api/v1/models/:id/capability-tests", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.revalidateModel(context.req.param("id"), context.get("actor").id));
  });
  app.post("/api/v1/models/:id/connection-tests", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.testModelConnection(context.req.param("id"), context.get("actor").id));
  });
  app.put("/api/v1/models/:id/protocol", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.configureModel(context.req.param("id"), await context.req.json(), context.get("actor").id));
  });
  app.delete("/api/v1/models/:id", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    await input.models.deleteModel(context.req.param("id"), context.get("actor").id);
    return context.body(null, 204);
  });
  app.put("/api/v1/model-configuration/draft", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.updateDraft(await context.req.json(), context.get("actor").id));
  });
  app.put("/api/v1/model-configuration/draft/assignments/:target", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    const target = modelAssignmentTargetSchema.parse(context.req.param("target"));
    const body = z.object({ modelId: z.string().uuid().nullable(), validationId: z.string().uuid().optional() }).parse(await context.req.json());
    return context.json(await input.models.updateAssignment(target, body.modelId, context.get("actor").id, body.validationId));
  });
  app.post("/api/v1/model-configuration/draft/assignments/:target/validations", authenticated, async context => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    const target = modelAssignmentTargetSchema.parse(context.req.param("target"));
    return context.json(await input.models.validateAssignment(target, context.get("actor").id));
  });
  app.post("/api/v1/model-configuration/draft/assignments/:target/candidate-validations", authenticated, async context => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    const target = modelAssignmentTargetSchema.parse(context.req.param("target"));
    const body = z.object({ modelId: z.string().uuid(), formalValidation: formalValidationSchema.optional() }).parse(await context.req.json());
    return context.json(await input.models.previewAssignment(target, body.modelId, context.get("actor").id, body.formalValidation), 201);
  });
  app.get("/api/v1/model-configuration/draft/assignments/:target/candidate-validations/:validationId", authenticated, async context => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    const target = modelAssignmentTargetSchema.parse(context.req.param("target"));
    return context.json(await input.models.getAssignmentValidation(target, context.req.param("validationId"), context.get("actor").id));
  });
  app.post("/api/v1/model-configuration/draft/validations", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    return context.json(await input.models.validateDraft(context.get("actor").id));
  });
  app.post("/api/v1/model-configuration/apply", authenticated, async (context) => {
    if (!input.models) throw new ControllerError("Model configuration is unavailable.", 503, "model_configuration_unavailable");
    const selection = partialModelActivationSchema.parse(await context.req.json());
    const revision = await input.models.applyConfiguration(context.get("actor").id, selection);
    const distribution = await input.runnerControl.distributeDesiredState("default", 10_000);
    if (distribution.distributionStatus === "ready") await input.models.finalizeActivation(revision.id);
    const view = await input.models.view();
    if (view.failed?.id === revision.id) {
      throw new ConflictError(view.failed.failureReason || "Runner rejected the Model configuration.", "model_configuration_runner_rejected");
    }
    return context.json({ ...view, distribution }, distribution.distributionStatus === "ready" ? 200 : 202);
  });

  app.get("/api/v1/guardrail-capabilities", authenticated, async context => {
    if (!input.models) throw new ControllerError("Model readiness is unavailable.", 503, "model_configuration_unavailable");
    return context.json(modelReadiness(await input.models.view()));
  });

  app.get("/api/v1/policy-catalog/detectors", authenticated, context => context.json({ items: input.service.policyResources.compiler.detectors }));
  app.get("/api/v1/policies/:id/definition", authenticated, async context => context.json(await input.service.policyResources.get(context.req.param("id"))));
  app.put("/api/v1/policies/:id/definition", authenticated, async context => {
    const body = z.object({ definition: policyDefinitionSchema, maintainer: z.string().trim().min(1).max(200), expectedRevision: z.number().int().nonnegative(), create: z.boolean().optional() }).parse(await context.req.json());
    if (body.definition.metadata.id !== context.req.param("id")) throw new ValidationError("Policy identity must match its URL.");
    return context.json(await input.service.policyResources.save({ ...body, ...(body.create === undefined ? {} : { create: body.create }), actorId: context.get("actor").id }));
  });
  app.post("/api/v1/policies/:id/definition/test-runs", authenticated, async context => context.json(await input.service.policyResources.validate(context.req.param("id"), context.get("actor").id, input.runnerControl.hasDefaultCompiler()), 202));
  app.get("/api/v1/policies/:id/definition/test-runs/latest", authenticated, async context => context.json(await input.service.policyResources.report(context.req.param("id"))));
  app.get("/api/v1/policies/:id/definition/test-runs/:runId", authenticated, async context => {
    const report = await input.service.policyResources.report(context.req.param("id"), context.req.param("runId"));
    if (!report) throw new NotFoundError("Policy test run", context.req.param("runId"));
    return context.json(report);
  });
  app.post("/api/v1/policies/:id/definition/publish", authenticated, async context => {
    const body = z.object({ expectedRevision: z.number().int().positive() }).parse(await context.req.json());
    return context.json(publicPolicy(await input.service.policyResources.publish(context.req.param("id"), body.expectedRevision, context.get("actor").id)), 201);
  });
  app.get("/api/v1/policies", authenticated, async (context) => {
    const items = publicPolicy(await input.service.listPolicies());
    return context.json({ items, count: items.length });
  });
  app.get("/api/v1/guardrail-profiles", authenticated, async (context) => {
    const items = await input.service.listGuardrailProfiles();
    return context.json({ directories: protectionDirectories, items, count: items.length });
  });
  // Compatibility route for existing API clients; both paths read the database.
  app.get("/api/v1/policy-catalog/protection-presets", authenticated, async (context) => {
    const items = await input.service.listGuardrailProfiles();
    // This is a preview, not a save/activation or evidence that runtime checks passed.
    return context.json({ directories: protectionDirectories, items, count: items.length });
  });
  app.get("/api/v1/policies/:id", authenticated, async (context) => context.json(publicPolicy(await input.service.getPolicy(context.req.param("id")))));
  app.post("/api/v1/policies", authenticated, async (context) => {
    const body = createProgrammablePolicySchema.parse(await context.req.json());
    return context.json(await input.service.createPolicy({ ...body, actorId: context.get("actor").id }), 201);
  });
  app.patch("/api/v1/policies/:id", authenticated, async (context) => {
    const body = updateProgrammablePolicySchema.parse(await context.req.json());
    return context.json(await input.service.updatePolicy({ id: context.req.param("id"), ...body, actorId: context.get("actor").id }));
  });
  app.delete("/api/v1/policies/:id", authenticated, async (context) => {
    await input.service.deletePolicy({ id: context.req.param("id"), actorId: context.get("actor").id });
    return context.body(null, 204);
  });
  app.get("/api/v1/policies/:id/draft/checks", authenticated, async (context) => {
    return context.json(await input.service.validatePolicy(context.req.param("id")));
  });
  app.get("/api/v1/policies/:id/test-runs/latest", authenticated, async (context) => {
    return context.json(await input.service.latestPolicyValidation(context.req.param("id")));
  });
  app.get("/api/v1/policies/:id/test-runs/:runId", authenticated, async context =>
    context.json(await input.service.getPolicyValidation(context.req.param("id"), context.req.param("runId"))));
  app.post("/api/v1/policies/:id/test-runs", authenticated, async (context) => {
    const run = await input.service.requestPolicyValidation({
      id: context.req.param("id"), actorId: context.get("actor").id,
      compilerAvailable: input.runnerControl.hasDefaultCompiler(),
    });
    const statusUrl = `/api/v1/policies/${encodeURIComponent(context.req.param("id"))}/test-runs/${encodeURIComponent(run.id)}`;
    context.header("Location", statusUrl);
    return context.json({ ...run, statusUrl }, 202);
  });
  app.post("/api/v1/policies/:id/publish", authenticated, async (context) => {
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
  app.post("/api/v1/authoring/intent-analyses", authenticated, async (context) => {
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
  app.post("/api/v1/authoring/document-analyses", authenticated, async (context) => {
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
  app.post("/api/v1/playground/guardrails/:guardrailId/draft-previews", authenticated, async (context) => {
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
  app.post("/api/v1/playground/guardrails/:guardrailId/draft-interactions", authenticated, async (context) => {
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
  app.post("/api/v1/authoring/plan-previews", authenticated, async (context) => {
    const body = guardrailInput.parse(await context.req.json());
    return context.json(await input.service.previewGuardrailPlan(body));
  });
  app.post("/api/v1/guardrails", authenticated, async (context) => {
    const body = guardrailInput.extend({ idempotencyKey: z.string().min(1).max(128).optional() }).parse(await context.req.json());
    return context.json(await input.service.createGuardrail({ ...body, actorId: context.get("actor").id }), 201);
  });
  app.get("/api/v1/guardrails/:id", authenticated, async (context) => {
    return context.json(await input.service.getGuardrail(context.req.param("id")));
  });
  app.get("/api/v1/guardrails/:id/package", authenticated, async context => {
    const versions = packageVersionsQuery.parse(context.req.query("versions"));
    const exported = await input.service.packages.exportPackage(context.req.param("id"), versions);
    context.header("Content-Type", "application/zip");
    context.header("Content-Disposition", `attachment; filename="${exported.filename}"`);
    context.header("Cache-Control", "no-store");
    return context.body(new Uint8Array(exported.bytes), 200);
  });
  app.post("/api/v1/guardrail-packages", authenticated, packageUploadLimit, async context => {
    const form = await context.req.formData();
    const upload = form.get("package");
    if (!(upload instanceof File)) throw new ControllerError("Upload a .guardrail.zip file in the package field.", 422, "guardrail_package_invalid");
    return context.json(await input.service.packages.inspectUpload(Buffer.from(await upload.arrayBuffer()), context.get("actor").id), 201);
  });
  app.get("/api/v1/guardrail-packages/:packageId", authenticated, async context => {
    return context.json(await input.service.packages.previewPackage(context.req.param("packageId")));
  });
  app.post("/api/v1/guardrail-packages/:packageId/imports", authenticated, async context => {
    const body = packageImportInput.parse(await context.req.json());
    return context.json(await input.service.packages.importPackage(context.req.param("packageId"), { ...body, actorId: context.get("actor").id }), 201);
  });
  app.post("/api/v1/guardrails/:id/versions/:version/environment-check", authenticated, async context => {
    return context.json(await input.service.packages.checkVersionEnvironment(context.req.param("id"), guardrailVersionInput.parse(context.req.param("version"))));
  });
  app.post("/api/v1/guardrails/:id/duplicate", authenticated, async context => {
    const body = z.object({ name: z.string().trim().min(1).max(160), sourceVersion: guardrailVersionInput.optional(), sourceDraftRevision: z.number().int().positive().optional(), idempotencyKey: z.string().min(1).max(128) })
      .refine(value => !(value.sourceVersion && value.sourceDraftRevision), "Choose one copy source").parse(await context.req.json());
    return context.json(await input.service.duplicateGuardrail({ ...body, id: context.req.param("id"), actorId: context.get("actor").id }), 201);
  });
  app.patch("/api/v1/guardrails/:id", authenticated, async (context) => {
    const body = guardrailUpdateInput.parse(await context.req.json());
    return context.json(await input.service.updateGuardrail({
      id: context.req.param("id"), actorId: context.get("actor").id, ...body,
    }));
  });
  app.post("/api/v1/guardrails/:id/publish", authenticated, async (context) => {
    const body = z.object({ expectedDraftRevision: z.number().int().positive() }).parse(await context.req.json());
    return context.json(await input.service.requestGuardrailPublish({
      expectedDraftRevision: body.expectedDraftRevision,
      guardrailId: context.req.param("id"),
      actorId: context.get("actor").id,
    }), 201);
  });
  app.get("/api/v1/guardrails/:id/draft-changes", authenticated, async context => {
    return context.json(await input.service.guardrailDraftChanges(context.req.param("id")));
  });
  app.post("/api/v1/guardrails/:id/discard-draft", authenticated, async context => {
    const body = z.object({ expectedDraftRevision: z.number().int().positive(), expectedBaselineVersion: guardrailVersionInput }).parse(await context.req.json());
    return context.json(await input.service.discardGuardrailDraft({ ...body, id: context.req.param("id"), actorId: context.get("actor").id }));
  });
  app.post("/api/v1/guardrails/:id/versions/:version/release", authenticated, async context => {
    const released = await input.service.releaseGuardrailVersion({ guardrailId: context.req.param("id"), version: guardrailVersionInput.parse(context.req.param("version")), actorId: context.get("actor").id });
    await input.runnerControl.distributeDesiredState();
    return context.json(released);
  });
  app.post("/api/v1/guardrails/:id/versions/:version/test-runs", authenticated, async context => {
    const body = await context.req.text();
    const options = validationTestOptions.parse(body.trim() ? JSON.parse(body) : {});
    const run = await input.service.requestVersionTestRun({ ...options, guardrailId: context.req.param("id"), version: guardrailVersionInput.parse(context.req.param("version")), actorId: context.get("actor").id });
    return context.json(run, 202);
  });
  app.get("/api/v1/guardrails/:id/versions/:version/test-suite", authenticated, async context => {
    return context.json(await input.service.guardrailVersionTestSuite(context.req.param("id"), guardrailVersionInput.parse(context.req.param("version"))));
  });
  app.get("/api/v1/guardrails/:id/versions/:version/deletion-impact", authenticated, async context => {
    return context.json(await input.service.guardrailVersionDeletionImpact(context.req.param("id"), guardrailVersionInput.parse(context.req.param("version"))));
  });
  app.delete("/api/v1/guardrails/:id/versions/:version", authenticated, async context => {
    await input.service.deleteGuardrailVersion({ guardrailId: context.req.param("id"), version: guardrailVersionInput.parse(context.req.param("version")), actorId: context.get("actor").id });
    return context.body(null, 204);
  });
  app.get("/api/v1/guardrails/:id/protection-mode", authenticated, async context => {
    return context.json(await input.service.protectionModes.get(context.req.param("id")));
  });
  app.patch("/api/v1/guardrails/:id/protection-mode", authenticated, async context => {
    const body = z.object({ mode: z.enum(protectionModes), expectedGeneration: z.number().int().nonnegative(),
      reason: z.string().trim().max(500).default("") }).strict().parse(await context.req.json());
    const result = await input.service.protectionModes.update({ ...body, id: context.req.param("id"), actorId: context.get("actor").id });
    await input.runnerControl.distributeProtectionModes();
    return context.json(result, 202);
  });
  app.get("/api/v1/guardrails/:id/logging", authenticated, async (context) => {
    return context.json(await input.service.guardrailLogging(context.req.param("id")));
  });
  app.patch("/api/v1/guardrails/:id/logging", authenticated, async (context) => {
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
  app.get("/api/v1/guardrails/:id/deletion-impact", authenticated, async (context) => {
    return context.json(await input.service.guardrailDeletionImpact(context.req.param("id")));
  });
  app.delete("/api/v1/guardrails/:id", authenticated, async (context) => {
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
  app.post("/api/v1/guardrails/:guardrailId/test-cases", authenticated, async (context) => {
    const body = testCaseInput.omit({ guardrailId: true }).parse(await context.req.json());
    return context.json(await input.service.createTestCase({ ...body, guardrailId: context.req.param("guardrailId"), actorId: context.get("actor").id }), 201);
  });
  app.delete("/api/v1/guardrails/:guardrailId/test-cases/:caseId", authenticated, async (context) => {
    await input.service.deleteTestCase({ guardrailId: context.req.param("guardrailId"), caseId: context.req.param("caseId"), actorId: context.get("actor").id });
    return context.body(null, 204);
  });
  app.patch("/api/v1/guardrails/:id/test-scope", authenticated, async (context) => {
    const body = validationScopeInput.parse(await context.req.json());
    return context.json(await input.service.setTestCaseExcluded({
      guardrailId: context.req.param("id"), caseId: body.caseId, excluded: body.excluded,
      actorId: context.get("actor").id,
    }));
  });
  app.get("/api/v1/test-runs", authenticated, async (context) => {
    return context.json(await input.service.queryValidationRuns(testingReportsQuery.parse(context.req.query())));
  });
  app.get("/api/v1/test-runs/:runId", authenticated, async (context) => {
    return context.json(await input.service.getValidationRun(context.req.param("runId"), context.req.query("view") === "summary"));
  });
  app.get("/api/v1/test-runs/:runId/deletion-impact", authenticated, async context => {
    return context.json(await input.service.testingReportDeletionImpact(context.req.param("runId")));
  });
  app.delete("/api/v1/test-runs/:runId", authenticated, async context => {
    const body = z.object({ expectedPendingVersion: z.string().nullable() }).parse(await context.req.json());
    await input.service.deleteTestingReport({ runId: context.req.param("runId"), actorId: context.get("actor").id, ...body });
    await input.runnerControl.distributeDesiredState();
    return context.body(null, 204);
  });
  app.post("/api/v1/guardrails/:guardrailId/test-runs", authenticated, async (context) => {
    const body = await context.req.text();
    const options = validationTestOptions.parse(body.trim() ? JSON.parse(body) : {});
    return context.json(await input.service.requestValidation({
      ...options,
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
    return context.json({ items: items.map((item) => ({ ...withEndpointSetup(item, context), ...distribution })) });
  });
  app.post("/api/v1/endpoints", authenticated, async (context) => {
    const body = endpointInput.parse(await context.req.json());
    const created = await input.service.createEndpoint({ ...body, actorId: context.get("actor").id });
    return context.json(await withDistribution(created, context, true), 201);
  });
  app.get("/api/v1/endpoints/:id", authenticated, async (context) => {
    return context.json(await withDistribution(await input.service.getEndpoint(context.req.param("id")), context));
  });
  app.patch("/api/v1/endpoints/:id", authenticated, async (context) => {
    const body = endpointUpdateInput.parse(await context.req.json());
    const updated = await input.service.updateEndpoint({
      id: context.req.param("id"),
      ...body,
      actorId: context.get("actor").id,
    });
    return context.json(await withDistribution(updated, context, true));
  });
  app.post("/api/v1/endpoints/:id/credentials", authenticated, async (context) => {
    const updated = await input.service.rotateEndpointCredential({
      id: context.req.param("id"),
      actorId: context.get("actor").id,
    });
    return context.json(await withDistribution(updated, context, true), 201);
  });
  app.delete("/api/v1/endpoints/:id/credentials/:credentialId", authenticated, async (context) => {
    await input.service.revokeEndpointCredential({
      id: context.req.param("id"),
      credentialId: context.req.param("credentialId"),
      actorId: context.get("actor").id,
    });
    await input.runnerControl.distributeDesiredState();
    return context.body(null, 204);
  });
  app.get("/api/v1/endpoints/:id/deletion-impact", authenticated, async (context) => {
    return context.json(await input.service.endpointDeletionImpact(context.req.param("id")));
  });
  app.delete("/api/v1/endpoints/:id", authenticated, async (context) => {
    const body = deletionInput.parse(await context.req.json());
    await input.service.softDeleteEndpoint({ id: context.req.param("id"), actorId: context.get("actor").id, ...body });
    await input.runnerControl.distributeDesiredState();
    return context.body(null, 204);
  });

  app.get("/api/v1/system/health", authenticated, async (context) => {
    context.header("Cache-Control", "no-store");
    const runners = await input.service.listRunnerHeartbeats().catch(() => null);
    const health = deriveComponentHealth(runners, {
      observedAt: new Date(), offlineAfterSeconds: input.config.offlineAfterSeconds,
    });
    const models = input.models ? await input.service.requiredPlatformModelBindings()
      .then(bindings => input.models!.modelHealth(bindings))
      .catch(() => ({ status: "unknown" as const, reason: "unknown" as const, bindings: [] }))
      : { status: "unknown" as const, reason: "unknown" as const, bindings: [] };
    return context.json(withModelHealth(health, models));
  });
  app.get("/api/v1/system/version", authenticated, async (context) => {
    const pools = await input.service.listRunnerPoolsWithCapacity();
    context.header("Cache-Control", "no-store");
    return context.json({
      controlPlane: controllerVersion,
      dataPlane: pools.flatMap(pool => pool.instances.map(runner => ({
        runnerId: runner.runnerId, poolId: pool.id, status: runner.status,
        lastHeartbeatAt: runner.lastHeartbeatAt,
        software: parseSoftwareVersion(runner.labels?.["tasklattice.build"], runner.runnerVersion),
      }))),
    });
  });
  app.get("/api/v1/runner-pools", authenticated, async (context) => context.json({ items: await input.service.listRunnerPoolsWithCapacity() }));
  app.patch("/api/v1/runner-pools/:id", authenticated, async (context) => {
    const body = runnerPoolInput.parse(await context.req.json());
    return context.json(await input.service.updateRunnerPool({ id: context.req.param("id"), actorId: context.get("actor").id, ...body }));
  });
  app.delete("/api/v1/runner-instances/:runnerId", authenticated, async (context) => {
    const query = z.object({
      force: z.enum(["true", "false"]).default("false"),
      bootId: z.string().min(1).max(256).optional(),
    }).refine(value => value.force !== "true" || Boolean(value.bootId), "Force removal requires the Runner boot ID.").parse(context.req.query());
    const removed = await input.service.removeRunnerInstance({
      runnerId: context.req.param("runnerId"),
      actorId: context.get("actor").id,
      ...(query.force === "true" ? { force: true, bootId: query.bootId! } : {}),
    });
    if (query.force === "true") input.runnerControl.removeRunnerConnection(context.req.param("runnerId"), removed.bootId);
    return context.body(null, 204);
  });
  app.get("/api/v1/routers", authenticated, async context => {
    const items = await input.service.trafficRouting.list();
    return context.json({ items, count: items.length });
  });
  app.get("/api/v1/routers/:id", authenticated, async context => context.json(await input.service.trafficRouting.get(context.req.param("id"))));
  app.post("/api/v1/routers", authenticated, async context => {
    const body = z.object({ name: z.string().trim().min(1).max(160), description: z.string().max(2000).default(""), endpointIds: z.array(z.string().min(1)).max(128).default([]), draft: routerDraftSchema }).parse(await context.req.json());
    return context.json(await input.service.trafficRouting.create(body.name, body.description, body.draft, context.get("actor").id, body.endpointIds), 201);
  });
  app.put("/api/v1/routers/:id/draft", authenticated, async context => {
    const body = z.object({ expectedDraftRevision: z.number().int().positive(), draft: routerDraftSchema }).parse(await context.req.json());
    return context.json(await input.service.trafficRouting.save(context.req.param("id"), body.expectedDraftRevision, body.draft, context.get("actor").id));
  });
  app.delete("/api/v1/routers/:id", authenticated, async context => {
    await input.service.trafficRouting.remove(context.req.param("id"), context.get("actor").id);
    await input.runnerControl.distributeDesiredState();
    return context.body(null, 204);
  });
  app.post("/api/v1/routers/:id/publication-preview", authenticated, async context => {
    const body = z.object({ expectedDraftRevision: z.number().int().positive() }).parse(await context.req.json());
    return context.json(await input.service.trafficRouting.preview(context.req.param("id"), body.expectedDraftRevision));
  });
  app.get("/api/v1/routers/:id/change-requests", authenticated, async context => {
    const items = await input.service.trafficRouting.changeRequests(context.req.param("id"));
    return context.json({ items, count: items.length });
  });
  app.post("/api/v1/routers/:id/change-requests", authenticated, async context => {
    const body = z.object({ expectedDraftRevision: z.number().int().positive(), reviewedSnapshot: routerDraftSchema, reviewedEndpointIds: z.array(z.string().min(1).max(256)).max(10000),
      reason: changeReason, ticket: z.string().trim().max(128).default(""),
      restore: z.object({ revision: z.number().int().positive(), expectedActiveRevision: z.number().int().positive() }).optional() }).parse(await context.req.json());
    await input.service.packages.checkRoutedImports(body.reviewedSnapshot);
    return context.json(await input.service.trafficRouting.submitChange(context.req.param("id"), body, context.get("actor").id), 201);
  });
  app.get("/api/v1/routers/:id/change-requests/:changeId", authenticated, async context => context.json(await input.service.trafficRouting.changeRequest(context.req.param("id"), context.req.param("changeId"))));
  app.post("/api/v1/routers/:id/change-requests/:changeId/approve", authenticated, async context => {
    const { note } = z.object({ note: z.string().trim().max(2000).optional() }).parse(await context.req.json());
    await input.service.packages.checkRoutedImports((await input.service.trafficRouting.changeRequest(context.req.param("id"), context.req.param("changeId"))).snapshot);
    const result = await input.service.trafficRouting.approveChange(context.req.param("id"), context.req.param("changeId"), context.get("actor").id, { note });
    if (!result.publication.replayed) await input.runnerControl.distributeDesiredState();
    return context.json(result, 202);
  });
  app.post("/api/v1/routers/:id/change-requests/:changeId/emergency-apply", authenticated, async context => {
    const emergency = z.object({ reason: changeReason }).parse(await context.req.json());
    await input.service.packages.checkRoutedImports((await input.service.trafficRouting.changeRequest(context.req.param("id"), context.req.param("changeId"))).snapshot);
    const result = await input.service.trafficRouting.approveChange(context.req.param("id"), context.req.param("changeId"), context.get("actor").id, { emergency });
    if (!result.publication.replayed) await input.runnerControl.distributeDesiredState();
    return context.json(result, 202);
  });
  app.post("/api/v1/routers/:id/change-requests/:changeId/reject", authenticated, async context => {
    const { note } = z.object({ note: changeReason }).parse(await context.req.json());
    return context.json(await input.service.trafficRouting.rejectChange(context.req.param("id"), context.req.param("changeId"), context.get("actor").id, note));
  });
  app.post("/api/v1/routers/:id/change-requests/:changeId/withdraw", authenticated, async context => context.json(await input.service.trafficRouting.withdrawChange(context.req.param("id"), context.req.param("changeId"), context.get("actor").id)));
  app.post("/api/v1/routers/:id/change-requests/:changeId/revert", authenticated, async context => {
    const { reason } = z.object({ reason: changeReason }).parse(await context.req.json());
    const result = await input.service.trafficRouting.revertChange(context.req.param("id"), context.req.param("changeId"), context.get("actor").id, reason);
    await input.runnerControl.distributeDesiredState();
    return context.json(result, 202);
  });
  app.delete("/api/v1/routers/:id/revisions/:revision", authenticated, async context => {
    await input.service.trafficRouting.deleteRevision(context.req.param("id"), z.coerce.number().int().positive().parse(context.req.param("revision")), context.get("actor").id);
    return context.body(null, 204);
  });
  app.put("/api/v1/routers/:id/endpoints", authenticated, async context => {
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
  app.post("/api/v1/playground/path-tests", authenticated, async context => {
    const body = pathTestSchema.parse(await context.req.json());
    let endpointAdapter: string | undefined;
    let parsed, businessRequest;
    try { parsed = parseHttpRequest(body.request); businessRequest = requestSource(parsed); } catch (error) { throw new ValidationError(error instanceof Error ? error.message : "Invalid HTTP request."); }
    if (body.target === "router") {
      const router = await input.service.trafficRouting.get(body.targetId);
      if (body.configuration === "draft") {
        if (body.action !== "simulate") throw new ValidationError("Draft routing can only be simulated.");
        if (body.expectedRevision !== router.draftRevision) throw new ValidationError("Router draft changed. Reload before testing.");
        const normalized = routingInputSchema.parse({ endpointId: body.endpointId || "simulated-endpoint", fields: body.fields, business_request: businessRequest, endpoint_request: body.endpointRequest });
        const rules = previewRouter(router.draft, normalized);
        const winner = router.draft.routes.find(route => rules.some(row => row.routeId === route.id && row.received));
        return context.json({ target: body.target, source: "controller-draft", status: 200, durationMs: 0, callId: body.callId,
          body: { simulation: true, rules, candidates: winner?.targets ?? [], draftRevision: router.draftRevision,
            note: "Draft matching only. Target weights are candidates; no runtime assignment or GuardRail execution." } });
      }
      if (!router.activeRevision || router.activeRevision !== body.expectedRevision) throw new ValidationError("Published Router revision changed. Reload before testing.");
      if (!router.endpointIds.includes(body.endpointId)) throw new ValidationError("Select an Endpoint bound to this Router.");
      routingInputSchema.parse({ endpointId: body.endpointId, fields: body.fields, business_request: businessRequest, endpoint_request: body.endpointRequest });
    } else {
      const endpoint = await input.service.getEndpoint(body.targetId);
      endpointAdapter = endpoint.adapter;
      if (endpointAdapter === "f5-scan") {
        body.credential ||= parsed.headers.authorization?.[0]?.replace(/^Bearer\s+/i, "") ?? "";
        await input.service.verifyScanTestCredential(body.targetId, body.credential);
      }
      if (body.configuration !== "published" || body.action !== "execute") throw new ValidationError("Endpoint tests execute the deployed configuration.");
    }
    if (!playgroundRunner) throw new ControllerError("Runner is not configured.", 503, "playground_runner_unavailable");
    return context.json(await playgroundRunner.testPath(body, endpointAdapter));
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
    const items = selectableSelectorFields(selected);
    return context.json({ items, endpoints: selected.map(e => ({ id: e.id, adapter: e.adapter })), count: items.length });
  });

  app.get("/api/v1/telemetry/security-events", authenticated, async (context) => {
    const query = securityEventsQuery.parse(context.req.query());
    return context.json(await input.service.querySecurityEvents(query));
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
      until: z.coerce.date().optional(),
      before: z.coerce.date().optional(),
      cursor: z.string().max(2048).optional(),
      requestId: z.string().max(256).optional(),
      direction: z.enum(['incoming','outgoing','completion']).optional(),
      outcome: z.enum(runtimeLogOutcomes).optional(),
      captured: z.enum(['true']).transform(() => true).optional(),
      findingsOnly: z.enum(['true']).transform(() => true).optional(),
      severity: z.string().describe('One or more comma-separated Rule risk levels: critical, high, medium, low, informational, unclassified. Matches any selected level before pagination.').transform(value => value.split(',')).pipe(z.array(z.enum(['critical','high','medium','low','informational','unclassified'])).min(1).max(6)).optional(),
    }).parse(context.req.query());
    return context.json(await input.service.queryRuntimeEvents(query));
  });
  app.get('/api/v1/telemetry/events/:id', authenticated, async context => {
    const query = z.object({ includeContent: z.enum(['true', 'false']).default('false') }).parse(context.req.query());
    return context.json(await input.service.getRuntimeEvent(context.req.param('id'), query.includeContent === 'true' && hasPermission(context.get('actor').role, 'runtime')));
  });
  app.get('/api/v1/telemetry/endpoint-activity', authenticated, async context => context.json(await input.service.runtimeEndpointActivity()));
  app.get('/api/v1/telemetry/metrics', authenticated, async context => {
    const scope = z.object({ window: z.enum(['1h','24h','7d','15d','30d']).default('24h'), guardrailId:z.string().max(256).optional(), routerId:z.string().max(256).optional() }).parse(context.req.query());
    return context.json(await input.service.runtimeMetrics(scope));
  });
  app.get("/api/v1/audit-events", authenticated, async (context) => {
    const query = auditQuerySchema.parse(context.req.query());
    return context.json(await input.service.listAuditEvents(query));
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
      if (error instanceof IntentAnalysisError) {
        const { diagnosticId, provider, model, stage, upstreamStatus, elapsedMs, timeoutMs } = error.detail;
        // Correlate failures without persisting user prompts, documents or provider response bodies.
        console.error(JSON.stringify({ event: "intent_analysis_failed", diagnosticId, provider, model, stage, upstreamStatus, elapsedMs, timeoutMs, status: error.status }));
      }
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
    // This small public build manifest must always reach the current replica.
    // It contains no application data and must not fall through to SPA HTML.
    app.use("/ui-version.json", async (context, next) => {
      context.header("Cache-Control", "no-store");
      await next();
    });
    app.get("/ui-version.json", serveStatic({ root: uiRoot, path: "ui-version.json" }));
    app.all("/ui-version.json", context => context.json({ error: "UI build unavailable" }, 404));
    // Hashed build assets must never fall through to the SPA document. During
    // an upgrade an old/new hash may be unavailable on a particular replica.
    app.use("/assets/*", async (context, next) => {
      await next();
      context.header("Cache-Control", context.res.status === 200 || context.res.status === 206
        ? "public, max-age=31536000, immutable" : "no-store");
    });
    app.use("/assets/*", serveStatic({ root: uiRoot }));
    app.all("/assets/*", context => {
      context.header("Cache-Control", "no-store");
      return context.text("Asset not found. Reload the page to load the current version.", 404);
    });
    app.use("/docs/diagrams/*", serveStatic({ root: uiRoot }));
    app.get("/docs/diagrams/*", context => context.text("Not found", 404));
    app.get("/favicon.svg", serveStatic({ root: uiRoot, path: "favicon.svg" }));
    app.get("/favicon.ico", serveStatic({ root: uiRoot, path: "favicon.ico" }));
    // Each navigation must fetch the document for the current deployment,
    // rather than retaining references to a previous build's asset hashes.
    app.get("*", async (context, next) => {
      context.header("Cache-Control", "no-store");
      await next();
    }, serveStatic({ root: uiRoot, path: "index.html" }));
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
        const accountPermission = requiredAccountPermission(context.req.method, context.req.path);
        if (!permission || !accountPermission || !hasPermission(actor.role, accountPermission.resource, accountPermission.action)
          || !allowsTokenPermission(actor.permissions, permission[2], permission[3], actor.role))
          return context.json({ error: { code: "insufficient_token_permission", message: "This token does not allow the requested operation." } }, 403);
      }
      if (!isAccountRole(actor.role)) return context.json({ error: { code: "forbidden", message: "A user or admin account is required." } }, 403);
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
    const role = session.user.role ?? "user";
    if (!isAccountRole(role)) return context.json({ error: { code: "forbidden", message: "A user or admin account is required." } }, 403);
    const permission = requiredAccountPermission(context.req.method, context.req.path);
    const accountRoute = context.req.path === "/api/v1/account/identity" || context.req.path === "/api/v1/account/access-tokens" || context.req.path.startsWith("/api/v1/account/access-tokens/");
    if ((!permission && !accountRoute) || (permission && !hasPermission(role, permission.resource, permission.action)))
      return context.json({ error: { code: "forbidden", message: "Your account role does not allow this operation." } }, 403);
    context.set("actor", { id: session.user.id, role });
    await next();
  };
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
