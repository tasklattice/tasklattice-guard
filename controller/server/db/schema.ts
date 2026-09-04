import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import type { GuardrailDraftConfig } from "../domain/guardrail-plan.js";
import type { ValidationCaseResult, ValidationMetrics } from "../domain/models.js";
import type {
  ModelAssignments,
  ModelProfile,
  ModelProviderKind,
  ModelResourceStatus,
  ModelRevisionState,
  ModelValidationReport,
} from "../model-config/domain.js";
import type { PolicyValidationResult, ProgrammablePolicyDraft, ProgrammablePolicySnapshot } from "../policy-studio/model.js";
import type {
  GuardrailLifecycleState,
  GuardrailVersionState,
  IntegrationLifecycleState,
  RunnerStatus,
  ValidationRunState,
} from "../../shared/lifecycle.js";

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// Better Auth owns these four models. Application code must not create,
// validate, hash, or rotate human credentials itself.
export const user = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  banned: boolean("banned").notNull().default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  preferredLanguage: text("preferred_language").notNull().default("en"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt,
  updatedAt,
});

export const session = pgTable("auth_session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  impersonatedBy: text("impersonated_by"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  createdAt,
  updatedAt,
}, (table) => [index("auth_session_user_idx").on(table.userId)]);

export const account = pgTable("auth_account", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt,
  updatedAt,
}, (table) => [
  index("auth_account_user_idx").on(table.userId),
  uniqueIndex("auth_account_issuer_idx").on(table.issuer, table.accountId),
]);

export const verification = pgTable("auth_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt,
  updatedAt,
}, (table) => [index("auth_verification_identifier_idx").on(table.identifier)]);

export const runnerPools = pgTable("runner_pool", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  desiredReplicas: integer("desired_replicas").notNull().default(1),
  safeRpsPerRunner: doublePrecision("safe_rps_per_runner").notNull().default(1),
  maxConcurrencyPerRunner: integer("max_concurrency_per_runner").notNull().default(64),
  createdAt,
  updatedAt,
}, (table) => [uniqueIndex("runner_pool_single_default_idx").on(table.isDefault).where(sql`${table.isDefault} = true`)]);

export const controllerState = pgTable("controller_state", {
  id: text("id").primaryKey(),
  desiredGeneration: bigint("desired_generation", { mode: "number" }).notNull().default(0),
  updatedAt,
});

export const modelProviders = pgTable("model_provider", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").$type<ModelProviderKind>().notNull(),
  baseUrl: text("base_url").notNull(),
  skipTlsVerify: boolean("skip_tls_verify").notNull().default(false),
  credentialCiphertext: text("credential_ciphertext").notNull(),
  credentialHint: text("credential_hint").notNull().default("Not required"),
  status: text("status").$type<ModelResourceStatus>().notNull().default("pending"),
  validationMessage: text("validation_message").notNull().default("Not validated."),
  validationLatencyMs: integer("validation_latency_ms"),
  validatedAt: timestamp("validated_at", { withTimezone: true }),
  createdBy: text("created_by").references(() => user.id),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("model_provider_name_idx").on(table.name),
  index("model_provider_status_idx").on(table.status),
]);

export const modelDefinitions = pgTable("model_definition", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull().references(() => modelProviders.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  model: text("model").notNull(),
  profile: text("profile").$type<ModelProfile>().notNull().default("generic-chat"),
  timeoutSeconds: integer("timeout_seconds").notNull().default(20),
  maxTokens: integer("max_tokens").notNull().default(512),
  // Transport health is independent of scenario/capability validation below.
  connectionStatus: text("connection_status").$type<ModelResourceStatus>().notNull().default("pending"),
  connectionMessage: text("connection_message").notNull().default("Not checked."),
  connectionLatencyMs: integer("connection_latency_ms"),
  connectionCheckedAt: timestamp("connection_checked_at", { withTimezone: true }),
  status: text("status").$type<ModelResourceStatus>().notNull().default("pending"),
  validationMessage: text("validation_message").notNull().default("Not validated."),
  validationLatencyMs: integer("validation_latency_ms"),
  validatedAt: timestamp("validated_at", { withTimezone: true }),
  createdBy: text("created_by").references(() => user.id),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("model_definition_provider_model_idx").on(table.providerId, table.model, table.profile),
  index("model_definition_provider_idx").on(table.providerId),
  index("model_definition_status_idx").on(table.status),
]);

export const modelConfigurationRevisions = pgTable("model_configuration_revision", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull(),
  state: text("state").$type<ModelRevisionState>().notNull().default("draft"),
  generation: bigint("generation", { mode: "number" }),
  assignments: jsonb("assignments").$type<ModelAssignments>().notNull(),
  validationReport: jsonb("validation_report").$type<ModelValidationReport>(),
  failureReason: text("failure_reason"),
  validatedAt: timestamp("validated_at", { withTimezone: true }),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  createdBy: text("created_by").references(() => user.id),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("model_configuration_revision_number_idx").on(table.revision),
  index("model_configuration_revision_state_idx").on(table.state),
]);

export const policyRecords = pgTable("policy_record", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  source: text("source").notNull().default("custom"),
  owner: text("owner").notNull(),
  draft: jsonb("draft").$type<ProgrammablePolicyDraft>().notNull(),
  draftRevision: integer("draft_revision").notNull().default(1),
  createdAt,
  updatedAt,
}, (table) => [index("policy_record_name_idx").on(table.name)]);

export const policyVersions = pgTable("policy_version", {
  policyId: text("policy_id").notNull().references(() => policyRecords.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  snapshot: jsonb("snapshot").$type<ProgrammablePolicySnapshot>().notNull(),
  checksum: text("checksum").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.policyId, table.version] }),
  uniqueIndex("policy_version_checksum_idx").on(table.checksum),
]);

export const policyValidationRuns = pgTable("policy_validation_run", {
  id: text("id").primaryKey(),
  policyId: text("policy_id").notNull().references(() => policyRecords.id, { onDelete: "cascade" }),
  draftRevision: integer("draft_revision").notNull(),
  status: text("status").$type<ValidationRunState>().notNull().default("queued"),
  results: jsonb("results").$type<PolicyValidationResult[]>().notNull().default([]),
  failureReason: text("failure_reason"),
  createdBy: text("created_by").notNull().references(() => user.id),
  createdAt,
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [index("policy_validation_run_policy_idx").on(table.policyId, table.createdAt)]);

export const guardrails = pgTable("guardrail", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  draftConfig: jsonb("draft_config").$type<GuardrailDraftConfig>().notNull(),
  draftRevision: integer("draft_revision").notNull().default(1),
  excludedTestCaseIds: jsonb("excluded_test_case_ids").$type<string[]>().notNull().default([]),
  loggingLevel: text("logging_level").notNull().default("info"),
  runtimeProfile: text("runtime_profile").notNull().default("auto"),
  status: text("status").$type<GuardrailLifecycleState>().notNull().default("draft"),
  desiredGeneration: bigint("desired_generation", { mode: "number" }).notNull().default(0),
  activeVersion: text("active_version"),
  activeArtifactId: text("active_artifact_id"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: text("deleted_by").references(() => user.id),
  deleteReason: text("delete_reason"),
  createdAt,
  updatedAt,
}, (table) => [index("guardrail_status_idx").on(table.status)]);

export const guardrailVersions = pgTable("guardrail_version", {
  guardrailId: text("guardrail_id").notNull().references(() => guardrails.id),
  version: text("version").notNull(),
  generation: bigint("generation", { mode: "number" }).notNull(),
  sourceDraftRevision: integer("source_draft_revision").notNull().default(1),
  status: text("status").$type<GuardrailVersionState>().notNull().default("compiling"),
  runtimeProfile: text("runtime_profile").notNull(),
  plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
  artifactId: text("artifact_id"),
  failureReason: text("failure_reason"),
  createdBy: text("created_by").references(() => user.id),
  createdAt,
}, (table) => [
  primaryKey({ columns: [table.guardrailId, table.version] }),
  uniqueIndex("guardrail_version_generation_idx").on(table.generation),
]);

export const testCases = pgTable("guardrail_test_case", {
  id: text("id").notNull(),
  guardrailId: text("guardrail_id").notNull().references(() => guardrails.id),
  name: text("name").notNull(),
  policyId: text("policy_id").notNull(),
  phase: text("phase").notNull(),
  content: text("content").notNull(),
  expectedDecision: text("expected_decision").notNull(),
  origin: text("origin").notNull().default("generated"),
  trustedInstruction: text("trusted_instruction").notNull().default(""),
  targetSource: text("target_source").notNull().default("user_input"),
  query: text("query").notNull().default(""),
  groundingSources: jsonb("grounding_sources").$type<string[]>().notNull().default([]),
  expectedReasoningResult: text("expected_reasoning_result"),
  caseType: text("case_type").notNull().default("scenario"),
  required: boolean("required").notNull().default(true),
  expectedFailure: text("expected_failure"),
  concurrencyGroup: text("concurrency_group"),
  sourcePolicyId: text("source_policy_id"),
  sourcePolicyVersion: text("source_policy_version"),
  sourceCaseId: text("source_case_id"),
  coveredRuleIds: jsonb("covered_rule_ids").$type<string[]>().notNull().default([]),
  updatedAt,
}, (table) => [
  primaryKey({ columns: [table.guardrailId, table.id] }),
  index("guardrail_test_case_guardrail_idx").on(table.guardrailId),
]);

export const validationRuns = pgTable("guardrail_validation_run", {
  id: text("id").primaryKey(),
  guardrailId: text("guardrail_id").notNull().references(() => guardrails.id),
  guardrailVersion: text("guardrail_version").notNull(),
  sourceDraftRevision: integer("source_draft_revision").notNull(),
  status: text("status").$type<ValidationRunState>().notNull().default("queued"),
  metrics: jsonb("metrics").$type<ValidationMetrics>().notNull().default({
    total: 0,
    passed: 0,
    complianceRate: 0,
    falsePositiveRate: 0,
    falseNegativeRate: 0,
    escalationRate: 0,
    p95LatencyMs: 0,
  }),
  results: jsonb("results").$type<ValidationCaseResult[]>().notNull().default([]),
  excludedCaseIds: jsonb("excluded_case_ids").$type<string[]>().notNull().default([]),
  failureReason: text("failure_reason"),
  createdBy: text("created_by").notNull().references(() => user.id),
  createdAt,
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [index("guardrail_validation_run_guardrail_idx").on(table.guardrailId, table.createdAt)]);

export const artifacts = pgTable("guardrail_artifact", {
  id: text("id").primaryKey(),
  guardrailId: text("guardrail_id").notNull().references(() => guardrails.id),
  guardrailVersion: text("guardrail_version").notNull(),
  generation: bigint("generation", { mode: "number" }).notNull(),
  compilerVersion: text("compiler_version").notNull(),
  nemoVersion: text("nemo_version").notNull(),
  runtimeProfile: text("runtime_profile").notNull(),
  plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
  configYaml: text("config_yaml").notNull(),
  colangContent: text("colang_content").notNull().default(""),
  prompts: jsonb("prompts").$type<unknown[]>().notNull().default([]),
  actionBindings: jsonb("action_bindings").$type<unknown[]>().notNull().default([]),
  dependencyManifest: jsonb("dependency_manifest").$type<unknown[]>().notNull().default([]),
  checksum: text("checksum").notNull(),
  signature: text("signature").notNull(),
  createdAt,
}, (table) => [
  uniqueIndex("guardrail_artifact_checksum_idx").on(table.checksum),
  index("guardrail_artifact_version_idx").on(table.guardrailId, table.guardrailVersion),
]);

export const integrations = pgTable("integration", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  adapter: text("adapter").notNull(),
  status: text("status").$type<IntegrationLifecycleState>().notNull().default("active"),
  verification: jsonb("verification").$type<Record<string, unknown>>().notNull().default({}),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: text("deleted_by").references(() => user.id),
  deleteReason: text("delete_reason"),
  createdAt,
  updatedAt,
}, (table) => [index("integration_status_idx").on(table.status)]);

export const deployments = pgTable("guardrail_deployment", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  guardrailId: text("guardrail_id").notNull().references(() => guardrails.id),
  integrationId: text("integration_id").references(() => integrations.id),
  poolId: text("pool_id").notNull().references(() => runnerPools.id),
  guardrailVersion: text("guardrail_version"),
  routeOrder: integer("route_order").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  trafficScope: jsonb("traffic_scope").$type<Record<string, unknown>>().notNull().default({}),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: text("deleted_by").references(() => user.id),
  deleteReason: text("delete_reason"),
  createdAt,
  updatedAt,
}, (table) => [
  index("deployment_guardrail_idx").on(table.guardrailId),
  index("deployment_integration_idx").on(table.integrationId),
  uniqueIndex("deployment_integration_route_order_idx").on(table.integrationId, table.routeOrder)
    .where(sql`${table.deletedAt} is null`),
  index("deployment_pool_idx").on(table.poolId),
]);

export type RunnerLoad = {
  inflight: number;
  maxConcurrency: number;
  queueDepth: number;
  requestsDelta: number;
  errorsDelta: number;
  timeoutsDelta: number;
  latencyP95Ms: number;
  cpuUtilization: number;
  memoryUtilization: number;
  activeGuardrails: number;
  compileQueueDepth: number;
  observationIntervalMs: number;
};

export const runnerInstances = pgTable("runner_instance", {
  runnerId: text("runner_id").primaryKey(),
  bootId: text("boot_id").notNull(),
  poolId: text("pool_id").notNull().references(() => runnerPools.id),
  status: text("status").$type<RunnerStatus>().notNull().default("offline"),
  runnerVersion: text("runner_version").notNull(),
  nemoVersion: text("nemo_version").notNull(),
  compilerCapable: boolean("compiler_capable").notNull().default(false),
  maxConcurrency: integer("max_concurrency").notNull(),
  labels: jsonb("labels").$type<Record<string, string>>().notNull().default({}),
  desiredGeneration: bigint("desired_generation", { mode: "number" }).notNull().default(0),
  appliedGeneration: bigint("applied_generation", { mode: "number" }).notNull().default(0),
  heartbeatSequence: bigint("heartbeat_sequence", { mode: "number" }).notNull().default(0),
  load: jsonb("load").$type<RunnerLoad>(),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  updatedAt,
}, (table) => [index("runner_instance_pool_idx").on(table.poolId)]);

export const runtimeEvents = pgTable("runtime_event", {
  id: text("id").primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  requestId: text("request_id").notNull(),
  runnerId: text("runner_id").notNull(),
  guardrailId: text("guardrail_id"),
  guardrailVersion: text("guardrail_version"),
  integrationId: text("integration_id"),
  deploymentId: text("deployment_id"),
  direction: text("direction").notNull(),
  decision: text("decision").notNull(),
  durationMs: integer("duration_ms").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  index("runtime_event_guardrail_time_idx").on(table.guardrailId, table.occurredAt),
  index("runtime_event_integration_time_idx").on(table.integrationId, table.occurredAt),
]);

export const telemetryWatermarks = pgTable("telemetry_watermark", {
  runnerId: text("runner_id").primaryKey(),
  lastEventOccurredAt: timestamp("last_event_occurred_at", { withTimezone: true }),
  lastReceivedAt: timestamp("last_received_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt,
});

export const auditEvents = pgTable("audit_event", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  actorId: text("actor_id").references(() => user.id),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("audit_resource_idx").on(table.resourceType, table.resourceId)]);

export const outboxEvents = pgTable("controller_outbox", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  aggregateId: text("aggregate_id").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt,
}, (table) => [index("controller_outbox_pending_idx").on(table.processedAt, table.availableAt)]);

export const schema = {
  user,
  session,
  account,
  verification,
  controllerState,
  modelProviders,
  modelDefinitions,
  modelConfigurationRevisions,
  runnerPools,
  guardrails,
  guardrailVersions,
  testCases,
  validationRuns,
  artifacts,
  integrations,
  deployments,
  runnerInstances,
  runtimeEvents,
  telemetryWatermarks,
  auditEvents,
  outboxEvents,
};
