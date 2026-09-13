import { TrafficRoutingService } from "./traffic-routing.js";
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { programmablePolicyProtection } from "../policy-studio/protection.js";
import { queryRuntimeMetrics, type MetricScope } from "./runtime-metrics.js";
import { boundedRead } from '../db/read-budget.js';
import { asText, findingSeverity, increment, jsonAggregate, jsonArrayLength, jsonElements, jsonObject, jsonText, jsonValue, literal, lowerText, rowValue, scalar, timestampValue } from '../db/postgres-expressions.js';
import { advisoryTransactionLock } from '../db/postgres-locks.js';

import { and, asc, count, countDistinct, desc, eq, exists, gt, gte, inArray, isNotNull, isNull, lt, lte, max, min, ne, or, sql, type SQL } from "drizzle-orm";

import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { planToWire } from "../control-channel/protocol-codec.js";
import {
  artifacts,
  auditEvents,
  controllerState,
  routers,
  guardrails,
  guardrailVersions,
  trafficRouters,
  trafficRouterRevisions,
  routeAssignments,
  endpoints,
  outboxEvents,
  policyRecords,
  policyValidationRuns,
  policyVersions,
  runnerInstances,
  runnerPools,
  runtimeEvents,
  telemetryWatermarks,
  testCases,
  validationRuns,
  type RunnerLoad,
} from "../db/schema.js";
import { calculatePoolCapacity } from "../domain/capacity.js";
import { isModelIndependent, publishedProtectionCoverage } from "../domain/protection-readiness.js";
import type { BasicProtectionSnapshot } from "../../shared/platform-status.js";
import { decodeRuntimeLogKey, decryptRuntimeLogPayload } from "../runtime-log-crypto.js";
import {
  DEFAULT_ROUTER_ID,
  DEFAULT_ROUTER_NAME,
  DEFAULT_GUARDRAIL_ID,
  DEFAULT_GUARDRAIL_NAME,
  defaultGuardrailDraft,
} from "../domain/defaults.js";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors.js";
import { buildGuardrailPlan, normalizeGuardrailDraft, type GuardrailDraftConfig } from "../domain/guardrail-plan.js";
import type { CompiledArtifactInput, DeletionImpact, RuntimeEventInput, ValidationCaseResult, ValidationMetrics } from "../domain/models.js";
import { applyValidationOverrides, emptyValidationMetrics, generatedTestCases } from "../domain/validation.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { registeredAction } from "../action-catalog/catalog.js";
import type { ValidationTerminalState } from "../../shared/lifecycle.js";
import { guardrailCategoryLabels } from "../../shared/guardrail-catalog.js";
import { guardrailVersionId } from "../../shared/guardrail-version.js";
import {
  flowRuleId,
  programmablePolicyDraftSchema,
  type PolicyValidationResult,
  type ProgrammablePolicyDraft,
  type ProgrammablePolicySnapshot,
} from "../policy-studio/model.js";
import {
  activeEndpointCredentials,
  appendEndpointCredential,
  issueEndpointCredential,
  publicEndpointCredentials,
  revokeEndpointCredential,
} from "./endpoint-credentials.js";

type RunnerRegistration = {
  runnerId: string;
  bootId: string;
  poolId: string;
  runnerVersion: string;
  nemoVersion: string;
  maxConcurrency: number;
  compilerCapable: boolean;
  labels: Record<string, string>;
  appliedGeneration: number;
};

export class ControlPlaneService {
  readonly trafficRouting: TrafficRoutingService;
  private catalog: PolicyCatalog | null = null;
  private readonly runtimeLogEncryptionKey: Buffer | null;

  constructor(
    private readonly db: ControllerDatabase,
    private readonly config: ControllerConfig,
  ) {
    this.trafficRouting = new TrafficRoutingService(db);
    this.runtimeLogEncryptionKey = decodeRuntimeLogKey(config.runtimeLogEncryptionKey);
  }

  async initialize(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(controllerState).values({ id: "singleton", desiredGeneration: 0 }).onConflictDoNothing();
      await tx.insert(runnerPools).values({
        id: "default",
        name: "GuardRails 0",
        isDefault: true,
        desiredReplicas: 2,
        safeRpsPerRunner: 50,
        maxConcurrencyPerRunner: 64,
      }).onConflictDoNothing();
      await advisoryTransactionLock(tx, 'tasklattice-guard-product-defaults');
      await this.ensureDefaultGuardrail(tx);
    });
  }

  async desiredGeneration(): Promise<number> {
    const [state] = await this.db.select().from(controllerState).where(eq(controllerState.id, "singleton"));
    return state?.desiredGeneration ?? 0;
  }

  async listPolicies() {
    const custom = await this.db.select().from(policyRecords).orderBy(asc(policyRecords.name), asc(policyRecords.id));
    const versions = await this.db.select().from(policyVersions).orderBy(desc(policyVersions.version));
    const versionsByPolicy = new Map<string, typeof versions>();
    for (const version of versions) {
      const items = versionsByPolicy.get(version.policyId) ?? [];
      items.push(version);
      versionsByPolicy.set(version.policyId, items);
    }
    return [
      ...this.policyCatalog().list(),
      ...custom.map((item) => programmablePolicyPayload(item, versionsByPolicy.get(item.id) ?? [])),
    ];
  }

  async getPolicy(id: string) {
    const builtIn = this.policyCatalog().get(id);
    if (builtIn) return builtIn;
    const [record] = await this.db.select().from(policyRecords).where(eq(policyRecords.id, id));
    if (!record) throw new NotFoundError("Policy", id);
    const versions = await this.db.select().from(policyVersions)
      .where(eq(policyVersions.policyId, id)).orderBy(desc(policyVersions.version));
    return programmablePolicyPayload(record, versions);
  }

  async createPolicy(input: {
    name: string;
    description: string;
    owner: string;
    draft: ProgrammablePolicyDraft;
    actorId: string;
  }) {
    const draft = programmablePolicyDraftSchema.parse(input.draft);
    this.validatePolicyDraft(`policy-preview`, draft, false);
    const id = `policy-${randomUUID()}`;
    const [created] = await this.db.transaction(async (tx) => {
      const rows = await tx.insert(policyRecords).values({
        id,
        name: input.name,
        description: input.description,
        source: "custom",
        owner: input.owner,
        draft,
      }).returning();
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "policy.created", actorId: input.actorId,
        resourceType: "policy", resourceId: id, detail: { name: input.name },
      });
      return rows;
    });
    if (!created) throw new Error("Policy creation did not return the stored resource.");
    return programmablePolicyPayload(created, []);
  }

  async updatePolicy(input: {
    id: string;
    name?: string | undefined;
    description?: string | undefined;
    owner?: string | undefined;
    draft?: ProgrammablePolicyDraft | undefined;
    actorId: string;
  }) {
    const [updated] = await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(policyRecords).where(eq(policyRecords.id, input.id)).for("update");
      if (!current) throw new NotFoundError("Policy", input.id);
      if (current.source !== "custom") throw new ValidationError("Built-in Policies are system managed.");
      const draft = input.draft ? programmablePolicyDraftSchema.parse(input.draft) : current.draft;
      this.validatePolicyDraft(input.id, draft, false);
      const rows = await tx.update(policyRecords).set({
        name: input.name ?? current.name,
        description: input.description ?? current.description,
        owner: input.owner ?? current.owner,
        draft,
        draftRevision: increment(policyRecords.draftRevision),
        updatedAt: new Date(),
      }).where(eq(policyRecords.id, input.id)).returning();
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "policy.updated", actorId: input.actorId,
        resourceType: "policy", resourceId: input.id, detail: { priorDraftRevision: current.draftRevision },
      });
      return rows;
    });
    if (!updated) throw new NotFoundError("Policy", input.id);
    const versions = await this.db.select().from(policyVersions)
      .where(eq(policyVersions.policyId, input.id)).orderBy(desc(policyVersions.version));
    return programmablePolicyPayload(updated, versions);
  }

  async deletePolicy(input: { id: string; actorId: string }): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (this.policyCatalog().get(input.id)) throw new ValidationError("Built-in Policies are system managed and cannot be deleted.");
      const [record] = await tx.select().from(policyRecords).where(eq(policyRecords.id, input.id)).for("update");
      if (!record) throw new NotFoundError("Policy", input.id);
      const activeGuardrails = await tx.select({ id: guardrails.id, name: guardrails.name, draftConfig: guardrails.draftConfig })
        .from(guardrails).where(isNull(guardrails.deletedAt));
      const referenced = activeGuardrails.filter((item) => normalizeGuardrailDraft(item.draftConfig).policyBindings.some((binding) => binding.policyId === input.id));
      if (referenced.length) {
        throw new ConflictError(
          `Policy ${record.name} is still referenced by Guardrail drafts: ${referenced.map((item) => item.name).join(", ")}.`,
          "policy_in_use",
        );
      }
      await tx.delete(policyRecords).where(eq(policyRecords.id, input.id));
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "policy.deleted", actorId: input.actorId,
        resourceType: "policy", resourceId: input.id, detail: { name: record.name },
      });
    });
  }

  async validatePolicy(id: string) {
    const record = await this.policyRecord(id);
    this.validatePolicyDraft(id, record.draft, true);
    const [latest] = await this.db.select().from(policyValidationRuns)
      .where(eq(policyValidationRuns.policyId, id)).orderBy(desc(policyValidationRuns.createdAt)).limit(1);
    const status = !latest ? "not_run" : latest.draftRevision !== record.draftRevision ? "stale" : latest.status;
    return {
      // Metadata checks alone are not NeMo compilation or executable evidence.
      valid: status === "passed",
      metadata_valid: true,
      validation_status: status,
      requires_runner_validation: status !== "passed",
      policy_id: id,
      draft_revision: record.draftRevision,
      colang_version: record.draft.colang_version,
      rails: record.draft.rail_bindings.map((item) => item.rail_type),
    };
  }

  async requestPolicyValidation(input: { id: string; actorId: string; compilerAvailable: boolean }) {
    if (!input.compilerAvailable) {
      throw new ConflictError("A healthy GuardRails 0 Runner is required to validate Policy drafts.", "default_runner_unavailable");
    }
    return this.db.transaction(async (tx) => {
      const [record] = await tx.select().from(policyRecords).where(eq(policyRecords.id, input.id)).for("update");
      if (!record) throw new NotFoundError("Policy", input.id);
      this.validatePolicyDraft(input.id, record.draft, true);
      if (!record.draft.test_cases.length) throw new ValidationError("Add at least one Test Case before creating a Validation Run.");
      const runId = `policy-validation-${randomUUID()}`;
      const candidateVersion = guardrailVersionId();
      const snapshot = policySnapshot(record, String(record.draftRevision), "");
      snapshot.checksum = createHash("sha256").update(stableJson(snapshot)).digest("hex");
      const plan = programmablePolicyPlan(record.id, record.name, candidateVersion, snapshot);
      await tx.insert(policyValidationRuns).values({
        id: runId,
        policyId: record.id,
        draftRevision: record.draftRevision,
        status: "queued",
        results: [],
        createdBy: input.actorId,
      });
      await tx.insert(outboxEvents).values({
        id: runId,
        kind: "policy.validation_requested",
        aggregateId: record.id,
        payload: {
          runId,
          guardrailId: `policy-preview-${record.id}`,
          candidateVersion,
          sourceDraftRevision: record.draftRevision,
          plan,
          runtimeProfile: "llmrails_colang2_programmable",
          testCases: record.draft.test_cases.map((item, index) => policyTestCasePayload(record.id, String(record.draftRevision), item, index)),
        },
      });
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "policy.validation_requested", actorId: input.actorId,
        resourceType: "policy", resourceId: record.id,
        detail: { runId, draftRevision: record.draftRevision, testCaseCount: record.draft.test_cases.length },
      });
      return (await tx.select().from(policyValidationRuns).where(eq(policyValidationRuns.id, runId)))[0]!;
    });
  }

  async getPolicyValidation(id: string, runId: string) {
    const [run] = await this.db.select().from(policyValidationRuns).where(and(eq(policyValidationRuns.policyId, id), eq(policyValidationRuns.id, runId)));
    if (!run) throw new NotFoundError("Policy validation run", runId);
    return policyValidationPayload(run);
  }

  async latestPolicyValidation(id: string) {
    await this.policyRecord(id);
    const [run] = await this.db.select().from(policyValidationRuns)
      .where(eq(policyValidationRuns.policyId, id)).orderBy(desc(policyValidationRuns.createdAt)).limit(1);
    return run ? policyValidationPayload(run) : { status: "not_run" as const };
  }

  async publishPolicy(input: { id: string; actorId: string; expectedDraftRevision?: number }) {
    return this.db.transaction(async (tx) => {
      const [record] = await tx.select().from(policyRecords).where(eq(policyRecords.id, input.id)).for("update");
      if (!record) throw new NotFoundError("Policy", input.id);
      // The locked Policy serializes both publication and draft edits. Retries
      // identify the validated draft, not whichever draft happens to be latest.
      const sourceDraftRevision = input.expectedDraftRevision ?? record.draftRevision;
      const [published] = await tx.select().from(policyVersions).where(and(
        eq(policyVersions.policyId, input.id),
        eq(policyVersions.sourceDraftRevision, sourceDraftRevision),
      )).limit(1);
      if (published) return published.snapshot;
      if (sourceDraftRevision !== record.draftRevision) {
        throw new ConflictError("The Policy draft changed. Validate the current draft before publishing.", "policy_draft_conflict");
      }
      this.validatePolicyDraft(input.id, record.draft, true);
      if (record.draft.test_cases.length) {
        const [latest] = await tx.select().from(policyValidationRuns)
          .where(eq(policyValidationRuns.policyId, input.id)).orderBy(desc(policyValidationRuns.createdAt)).limit(1);
        if (!latest || latest.draftRevision !== record.draftRevision || latest.status !== "passed") {
          throw new ConflictError("The current Policy draft must pass validation before publishing.", "policy_validation_required");
        }
      }
      const [latestVersion] = await tx.select({ value: max(policyVersions.version) }).from(policyVersions)
        .where(eq(policyVersions.policyId, input.id));
      const version = (latestVersion?.value ?? 0) + 1;
      const publishedAt = new Date();
      const snapshot = policySnapshot(record, String(version), "", publishedAt);
      const checksum = createHash("sha256").update(stableJson(snapshot)).digest("hex");
      snapshot.checksum = checksum;
      await tx.insert(policyVersions).values({ policyId: input.id, version, sourceDraftRevision, snapshot, checksum, publishedAt });
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "policy.version_published", actorId: input.actorId,
        resourceType: "policy", resourceId: input.id, detail: { version, checksum, draftRevision: record.draftRevision },
      });
      return snapshot;
    });
  }

  async listGuardrails() {
    const rows = await this.db.select().from(guardrails).where(isNull(guardrails.deletedAt)).orderBy(desc(guardrails.updatedAt));
    return Promise.all(rows.map((row) => this.guardrailSummary(row)));
  }

  async defaultGuardrailReadiness(): Promise<BasicProtectionSnapshot> {
    const [guardrail] = await this.db.select().from(guardrails).where(and(
      eq(guardrails.id, DEFAULT_GUARDRAIL_ID),
      isNull(guardrails.deletedAt),
    )).limit(1);
    const [router] = await this.db.select().from(routers).where(and(
      eq(routers.id, DEFAULT_ROUTER_ID),
      isNull(routers.deletedAt),
    )).limit(1);
    const [compiling] = await this.db.select({ version: guardrailVersions.version }).from(guardrailVersions).where(and(
      eq(guardrailVersions.guardrailId, DEFAULT_GUARDRAIL_ID),
      eq(guardrailVersions.status, "compiling"),
    )).limit(1);
    const [validation] = guardrail ? await this.db.select().from(validationRuns).where(and(
      eq(validationRuns.guardrailId, DEFAULT_GUARDRAIL_ID),
      eq(validationRuns.sourceDraftRevision, guardrail.draftRevision),
    )).orderBy(desc(validationRuns.createdAt)).limit(1) : [];

    const [version] = guardrail?.activeVersion ? await this.db.select().from(guardrailVersions).where(and(
      eq(guardrailVersions.guardrailId, DEFAULT_GUARDRAIL_ID),
      eq(guardrailVersions.version, guardrail.activeVersion),
    )).limit(1) : [];
    const [artifact] = guardrail?.activeArtifactId ? await this.db.select().from(artifacts)
      .where(eq(artifacts.id, guardrail.activeArtifactId)).limit(1) : [];
    const guardrailActive = Boolean(guardrail && guardrail.status !== "disabled"
      && version?.status === "ready" && version.artifactId === artifact?.id
      && artifact?.id === guardrail.activeArtifactId
      && artifact?.guardrailId === DEFAULT_GUARDRAIL_ID && artifact.guardrailVersion === guardrail.activeVersion
      && artifact.checksum && artifact.signature);
    const coverage = guardrailActive ? publishedProtectionCoverage(artifact?.plan) : null;
    const hasChecks = Boolean(coverage && (coverage.inputChecks > 0 || coverage.outputChecks > 0));
    const routerActive = Boolean(
      guardrailActive
      && router?.enabled
      && router.guardrailId === DEFAULT_GUARDRAIL_ID
      && router.guardrailVersion === guardrail?.activeVersion
      && router.poolId === "default"
      && isCatchAllTrafficScope(router.trafficScope),
    );
    const preparing = guardrail?.status !== "disabled" && Boolean(compiling || validation?.status === "queued" || validation?.status === "running");
    const initializing = Boolean(guardrail && (!guardrailActive || !routerActive) && preparing);

    return {
      status: routerActive && hasChecks ? "ready" : initializing ? "initializing" : "unavailable",
      guardrailStatus: guardrailActive ? "active" as const : preparing ? "initializing" as const : "unavailable" as const,
      routerStatus: routerActive ? "active" as const : preparing ? "initializing" as const : "unavailable" as const,
      activeVersion: guardrail?.activeVersion ?? null,
      modelIndependent: isModelIndependent(coverage),
      coverage,
      draft: {
        revision: guardrail?.draftRevision ?? 0,
        activeRevision: guardrailActive ? version?.sourceDraftRevision ?? null : null,
        validationStatus: validation?.status ?? null,
        validationFailureReason: validation?.failureReason ?? null,
      },
    };
  }

  async getGuardrail(id: string) {
    const [guardrail] = await this.db.select().from(guardrails).where(and(eq(guardrails.id, id), isNull(guardrails.deletedAt)));
    if (!guardrail) throw new NotFoundError("Guardrail", id);
    const versions = await this.db.select().from(guardrailVersions)
      .where(eq(guardrailVersions.guardrailId, id)).orderBy(desc(guardrailVersions.version));
    const artifactRows = await this.db.select().from(artifacts).where(eq(artifacts.guardrailId, id));
    const artifactsById = new Map(artifactRows.map((artifact) => [artifact.id, artifact]));
    return {
      ...await this.guardrailSummary(guardrail),
      versions: versions.map(({ sourceSnapshot, ...version }) => ({
        ...version,
        hasSourceSnapshot: Boolean(sourceSnapshot),
        artifact: version.artifactId ? artifactsById.get(version.artifactId) ?? null : null,
      })),
    };
  }

  async playgroundDraftCandidate(id: string) {
    const [guardrail] = await this.db.select().from(guardrails).where(and(
      eq(guardrails.id, id),
      isNull(guardrails.deletedAt),
    ));
    if (!guardrail) throw new NotFoundError("Guardrail", id);
    const candidateVersion = guardrailVersionId();
    const draft = normalizeGuardrailDraft(guardrail.draftConfig);
    const programmablePolicies = await this.resolveProgrammablePolicies(draft);
    const plan = buildGuardrailPlan({
      guardrailId: id,
      guardrailVersion: candidateVersion,
      draft,
      policies: this.policyCatalog().list(),
      programmablePolicies,
    });
    return {
      guardrailId: id,
      guardrailName: guardrail.name,
      draftRevision: guardrail.draftRevision,
      candidateVersion,
      runtimeProfile: guardrail.runtimeProfile,
      compilerVersion: String(plan.compiler_version ?? "tasklattice-controller-plan-v3"),
      plan,
    };
  }

  async previewGuardrailPlan(input: {
    draftConfig: GuardrailDraftConfig;
    runtimeProfile: string;
  }) {
    const draftConfig = normalizeGuardrailDraft(input.draftConfig);
    const programmablePolicies = await this.validateGuardrailDraft(draftConfig);
    const plan = buildGuardrailPlan({
      guardrailId: "draft-preview",
      guardrailVersion: guardrailVersionId(),
      draft: draftConfig,
      policies: this.policyCatalog().list(),
      programmablePolicies,
    });
    const steps = Array.isArray(plan.steps) ? plan.steps as Array<Record<string, unknown>> : [];
    const modules = Array.isArray(plan.modules) ? plan.modules as Array<Record<string, unknown>> : [];
    const rails = steps.flatMap((step) => {
      const phases = Array.isArray(step.phases) ? step.phases.filter((phase): phase is string => typeof phase === "string") : [];
      return phases.map((phase) => ({ rail_type: phase, flow: String(step.id ?? step.capability ?? "runtime-step") }));
    });
    const actions = steps.map((step) => {
      const stepId = String(step.id ?? step.capability ?? "runtime-step");
      const module = modules.find((candidate) => Array.isArray(candidate.step_ids) && candidate.step_ids.includes(stepId));
      return {
        name: String(step.capability ?? stepId),
        version: "controller-plan-v3",
        flow: stepId,
        timeout_ms: typeof module?.timeout_ms === "number" ? module.timeout_ms : 0,
        failure_mode: typeof module?.failure_mode === "string" ? module.failure_mode : "fail_closed",
      };
    });
    return {
      guardrail_id: "",
      candidate_version: String(plan.guardrail_version),
      engine: "GuardRails 0 · NeMo",
      colang_version: input.runtimeProfile === "llmrails_colang1_standard" ? "1.0" : input.runtimeProfile === "llmrails_colang2_programmable" ? "2.x" : "auto",
      compiler_version: String(plan.compiler_version ?? "tasklattice-controller-plan-v3"),
      checksum: createHash("sha256").update(stableJson({ draftConfig, runtimeProfile: input.runtimeProfile })).digest("hex"),
      rails,
      parallel_groups: modules.map((module) => String(module.id ?? "")).filter(Boolean),
      actions,
      models: [],
      dependency_manifest: [],
      estimated_critical_path_ms: modules.reduce((total, module) => total + (typeof module.timeout_ms === "number" ? module.timeout_ms : 0), 0),
    };
  }

  async createGuardrail(input: {
    name: string;
    draftConfig: GuardrailDraftConfig;
    runtimeProfile: string;
    actorId: string;
  }) {
    const draftConfig = normalizeGuardrailDraft(input.draftConfig);
    await this.validateGuardrailDraft(draftConfig);
    const id = randomUUID();
    const [created] = await this.db.transaction(async (tx) => {
      const rows = await tx.insert(guardrails).values({
        id,
        name: input.name,
        draftConfig,
        runtimeProfile: input.runtimeProfile,
      }).returning();
      await this.syncGeneratedTestCases(tx, id, draftConfig);
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.created", actorId: input.actorId,
        resourceType: "guardrail", resourceId: id,
        detail: { name: input.name },
      });
      return rows;
    });
    if (!created) throw new Error("Guardrail creation did not return the stored resource.");
    return this.guardrailSummary(created);
  }

  async duplicateGuardrail(input: { id: string; name: string; sourceVersion?: string | undefined; sourceDraftRevision?: number | undefined; idempotencyKey: string; actorId: string }) {
    const duplicateKey = `${input.actorId}:${input.idempotencyKey}`;
    const id = await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, `guardrail-duplicate:${duplicateKey}`);
      const [existing] = await tx.select().from(guardrails).where(eq(guardrails.duplicateKey, duplicateKey));
      const requestDigest = createHash("sha256").update(stableJson({ id: input.id, name: input.name, sourceVersion: input.sourceVersion, sourceDraftRevision: input.sourceDraftRevision })).digest("hex");
      if (existing) {
        if (existing.copyOrigin?.requestDigest !== requestDigest) throw new ConflictError("Idempotency key was used for a different copy request.", "duplicate_key_conflict");
        return existing.id;
      }
      const [source] = await tx.select().from(guardrails).where(and(eq(guardrails.id, input.id), isNull(guardrails.deletedAt))).for("share");
      if (!source) throw new NotFoundError("Guardrail", input.id);
      let snapshot: NonNullable<typeof guardrailVersions.$inferSelect.sourceSnapshot>;
      let sourceVersion = input.sourceVersion;
      if (input.sourceDraftRevision !== undefined) {
        if (source.draftRevision !== input.sourceDraftRevision) throw new ConflictError("The source draft changed. Reload before copying.", "guardrail_draft_conflict");
        snapshot = { draftConfig: source.draftConfig, runtimeProfile: source.runtimeProfile, loggingLevel: source.loggingLevel, excludedTestCaseIds: source.excludedTestCaseIds, testCases: await tx.select().from(testCases).where(eq(testCases.guardrailId, input.id)) };
      } else {
        sourceVersion ??= source.activeVersion ?? undefined;
        if (!sourceVersion) throw new ValidationError("Choose a source draft revision or a published Guardrail Version.");
        const [version] = await tx.select().from(guardrailVersions).where(and(eq(guardrailVersions.guardrailId, input.id), eq(guardrailVersions.version, sourceVersion)));
        if (!version?.sourceSnapshot) throw new ConflictError("This version has no complete source snapshot. Choose the current draft explicitly, or publish a new version before copying.", "source_snapshot_unavailable");
        snapshot = version.sourceSnapshot;
      }
      const copiedId = randomUUID();
      const copyOrigin = { sourceGuardrailId: input.id, sourceName: source.name, sourceVersion: sourceVersion ?? null, sourceDraftRevision: input.sourceDraftRevision ?? null, copiedAt: new Date().toISOString(), contentDigest: createHash("sha256").update(stableJson(snapshot)).digest("hex"), requestDigest };
      await tx.insert(guardrails).values({ id: copiedId, name: input.name, draftConfig: snapshot.draftConfig, runtimeProfile: snapshot.runtimeProfile, loggingLevel: snapshot.loggingLevel as "info" | "debug" | "trace", excludedTestCaseIds: snapshot.excludedTestCaseIds, copyOrigin, duplicateKey });
      // Case IDs are scoped by Guardrail; preserve IDs so exclusion/override references remain exact.
      if (snapshot.testCases?.length) await tx.insert(testCases).values(snapshot.testCases.map(c => ({ ...c, guardrailId: copiedId, updatedAt: new Date() })));
      else await this.syncGeneratedTestCases(tx, copiedId, snapshot.draftConfig);
      await tx.insert(auditEvents).values({ id: randomUUID(), kind: "guardrail.duplicated", actorId: input.actorId, resourceType: "guardrail", resourceId: copiedId, detail: copyOrigin });
      return copiedId;
    });
    return this.getGuardrail(id);
  }

  async updateGuardrail(input: {
    id: string;
    actorId: string;
    name?: string | undefined;
    draftConfig?: GuardrailDraftConfig | undefined;
    runtimeProfile?: string | undefined;
  }) {
    const updated = await this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(guardrails).where(and(
        eq(guardrails.id, input.id), isNull(guardrails.deletedAt),
      )).for("update");
      if (!existing) throw new NotFoundError("Guardrail", input.id);
      const draftConfig = input.draftConfig ? normalizeGuardrailDraft(input.draftConfig) : normalizeGuardrailDraft(existing.draftConfig);
      await this.validateGuardrailDraft(draftConfig);
      // Runtime profile affects compilation just as a Policy edit does. A
      // validation for the old profile cannot authorize a new executable.
      const draftChanged = input.draftConfig !== undefined
        || (input.runtimeProfile !== undefined && input.runtimeProfile !== existing.runtimeProfile);
      const nextExcluded = draftChanged ? await this.syncGeneratedTestCases(tx, input.id, draftConfig, existing.excludedTestCaseIds) : existing.excludedTestCaseIds;
      const [stored] = await tx.update(guardrails).set({
        name: input.name ?? existing.name,
        draftConfig,
        runtimeProfile: input.runtimeProfile ?? existing.runtimeProfile,
        ...(draftChanged ? {
          draftRevision: increment(guardrails.draftRevision),
          excludedTestCaseIds: nextExcluded,
        } : {}),
        updatedAt: new Date(),
      }).where(and(eq(guardrails.id, input.id), isNull(guardrails.deletedAt))).returning();
      if (!stored) throw new NotFoundError("Guardrail", input.id);
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.draft_updated", actorId: input.actorId,
        resourceType: "guardrail", resourceId: input.id,
        detail: { previousDraftRevision: existing.draftRevision, draftChanged },
      });
      return stored;
    });
    return this.guardrailSummary(updated);
  }

  async requestGuardrailPublish(input: {
    guardrailId: string;
    actorId: string;
    compilerAvailable: boolean;
    expectedDraftRevision?: number;
  }) {
    return this.db.transaction(async (tx) => {
      const [guardrail] = await tx.select().from(guardrails).where(and(
        eq(guardrails.id, input.guardrailId), isNull(guardrails.deletedAt),
      )).for("update");
      if (!guardrail) throw new NotFoundError("Guardrail", input.guardrailId);
      if (input.expectedDraftRevision !== undefined && input.expectedDraftRevision !== guardrail.draftRevision) throw new ConflictError("Guardrail draft changed. Review the current draft before publishing.", "guardrail_draft_conflict");
      const [latestValidation] = await tx.select().from(validationRuns).where(and(
        eq(validationRuns.guardrailId, input.guardrailId),
        eq(validationRuns.sourceDraftRevision, guardrail.draftRevision),
        eq(validationRuns.status, "passed"),
      )).orderBy(desc(validationRuns.createdAt)).limit(1);
      if (!latestValidation) {
        throw new ConflictError(
          "Run and pass Validation for the current Guardrail draft before publishing.",
          "guardrail_validation_required",
          { draftRevision: guardrail.draftRevision },
        );
      }
      const version = guardrailVersionId(latestValidation.createdAt);
      const [existingVersion] = await tx.select().from(guardrailVersions).where(and(
        eq(guardrailVersions.guardrailId, input.guardrailId),
        eq(guardrailVersions.version, version),
      )).limit(1);
      if (existingVersion && existingVersion.status !== "failed") {
        await tx.update(validationRuns).set({ guardrailVersion: existingVersion.version })
          .where(eq(validationRuns.id, latestValidation.id));
        const needsActivation = existingVersion.status === "ready" && (
          guardrail.status !== "active"
          || guardrail.activeVersion !== existingVersion.version
          || guardrail.activeArtifactId !== existingVersion.artifactId
        );
        if (needsActivation) {
          if (!existingVersion.artifactId) {
            throw new ConflictError(
              "The ready Guardrail Version does not have a compiled Artifact.",
              "guardrail_version_artifact_missing",
            );
          }
          const [state] = await tx.update(controllerState)
            .set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
            .where(eq(controllerState.id, "singleton"))
            .returning();
          if (!state) throw new Error("Controller state is not initialized.");
          await tx.update(guardrails).set({
            status: "active",
            activeVersion: existingVersion.version,
            activeArtifactId: existingVersion.artifactId,
            desiredGeneration: state.desiredGeneration,
            updatedAt: new Date(),
          }).where(eq(guardrails.id, input.guardrailId));
          await tx.update(routers).set({
            guardrailVersion: existingVersion.version,
            updatedAt: new Date(),
          }).where(and(eq(routers.guardrailId, input.guardrailId), isNull(routers.deletedAt)));
          if (input.guardrailId === DEFAULT_GUARDRAIL_ID) {
            await this.ensureDefaultRouter(tx, existingVersion.version);
          }
          await tx.insert(outboxEvents).values({
            id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: input.guardrailId,
            payload: {
              guardrailId: input.guardrailId,
              version: existingVersion.version,
              generation: state.desiredGeneration,
              artifactId: existingVersion.artifactId,
            },
          });
          await tx.insert(auditEvents).values({
            id: randomUUID(), kind: "guardrail.version_activated", actorId: input.actorId,
            resourceType: "guardrail", resourceId: input.guardrailId,
            detail: { version: existingVersion.version, generation: state.desiredGeneration, reusedArtifact: true },
          });
          return {
            compileId: null,
            guardrailId: input.guardrailId,
            version: existingVersion.version,
            generation: state.desiredGeneration,
            status: existingVersion.status,
          };
        }
        return {
          compileId: null,
          guardrailId: input.guardrailId,
          version: existingVersion.version,
          generation: existingVersion.generation,
          status: existingVersion.status,
        };
      }
      if (existingVersion?.status === "failed") {
        throw new ConflictError(
          "The previous compilation failed. Run Validation again to create a new timestamped Guardrail Version.",
          "guardrail_validation_required",
          { draftRevision: guardrail.draftRevision },
        );
      }
      if (!input.compilerAvailable) {
        throw new ConflictError(
          "A healthy GuardRails 0 Runner is required to compile Guardrail configurations.",
          "default_runner_unavailable",
        );
      }
      const [state] = await tx.update(controllerState)
        .set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton"))
        .returning();
      if (!state) throw new Error("Controller state is not initialized.");
      const programmablePolicies = await this.resolveProgrammablePolicies(normalizeGuardrailDraft(guardrail.draftConfig));
      const plan = buildGuardrailPlan({
        guardrailId: input.guardrailId,
        guardrailVersion: version,
        draft: normalizeGuardrailDraft(guardrail.draftConfig),
        policies: this.policyCatalog().list(),
        programmablePolicies,
      });
      await this.assertValidatedPlan(tx, latestValidation.id, plan, guardrail.runtimeProfile);
      const compileId = randomUUID();
      await tx.insert(guardrailVersions).values({
        guardrailId: input.guardrailId,
        version,
        generation: state.desiredGeneration,
        sourceDraftRevision: guardrail.draftRevision,
        sourceSnapshot: { draftConfig: guardrail.draftConfig, runtimeProfile: guardrail.runtimeProfile, loggingLevel: guardrail.loggingLevel, excludedTestCaseIds: guardrail.excludedTestCaseIds, testCases: await tx.select().from(testCases).where(eq(testCases.guardrailId, input.guardrailId)) },
        status: "compiling",
        runtimeProfile: guardrail.runtimeProfile,
        plan,
        createdBy: input.actorId,
      });
      await tx.update(guardrails).set({
        status: guardrail.activeArtifactId ? "active" : "draft",
        desiredGeneration: state.desiredGeneration,
        updatedAt: new Date(),
      }).where(eq(guardrails.id, input.guardrailId));
      await tx.insert(outboxEvents).values({
        id: compileId,
        kind: "guardrail.compile_requested",
        aggregateId: input.guardrailId,
        payload: {
          compileId,
          guardrailId: input.guardrailId,
          guardrailVersion: version,
          generation: state.desiredGeneration,
          plan,
          runtimeProfile: guardrail.runtimeProfile,
        },
      });
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.publish_requested", actorId: input.actorId,
        resourceType: "guardrail", resourceId: input.guardrailId,
        detail: { version, generation: state.desiredGeneration },
      });
      await tx.update(validationRuns).set({ guardrailVersion: version })
        .where(eq(validationRuns.id, latestValidation.id));
      return { compileId, guardrailId: input.guardrailId, version, generation: state.desiredGeneration, status: "compiling" };
    });
  }

  async acceptCompiledArtifact(input: Omit<CompiledArtifactInput, "checksum" | "signature" | "id"> & { compileId: string }) {
    const canonical = stableJson({
      guardrailId: input.guardrailId,
      guardrailVersion: input.guardrailVersion,
      generation: input.generation,
      compilerVersion: input.compilerVersion,
      nemoVersion: input.nemoVersion,
      runtimeProfile: input.runtimeProfile,
      plan: input.plan,
      configYaml: input.configYaml,
      colangContent: input.colangContent,
      prompts: input.prompts,
      actionBindings: input.actionBindings,
      dependencyManifest: input.dependencyManifest,
    });
    const checksum = createHash("sha256").update(canonical).digest("hex");
    const signature = sign(
      null,
      Buffer.from(checksum, "utf8"),
      createPrivateKey(readFileSync(this.config.artifactSigningKeyPath)),
    ).toString("base64");
    const proposedArtifactId = randomUUID();
    const stored = await this.db.transaction(async (tx) => {
      // Serialize publication/rollback and completion for this Guardrail. A
      // slower, older compile may become a ready version, never the active one.
      const [guardrail] = await tx.select().from(guardrails).where(and(
        eq(guardrails.id, input.guardrailId), isNull(guardrails.deletedAt),
      )).for("update");
      if (!guardrail) throw new NotFoundError("Guardrail", input.guardrailId);
      const [version] = await tx.select().from(guardrailVersions).where(and(
        eq(guardrailVersions.guardrailId, input.guardrailId),
        eq(guardrailVersions.version, input.guardrailVersion),
        eq(guardrailVersions.generation, input.generation),
      )).for("update");
      if (!version) throw new ConflictError("Compile result does not match an outstanding version.", "stale_compile_result");
      // Compare the executable wire contract (including order and overrides),
      // ignoring domain-only metadata that protobuf deliberately omits.
      if (stableJson(planToWire(input.plan)) !== stableJson(planToWire(version.plan))) {
        throw new ConflictError("Compile result changed the requested executable plan.", "compile_plan_mismatch");
      }
      if (version.status === "ready" && version.artifactId) {
        const [existing] = await tx.select().from(artifacts).where(eq(artifacts.id, version.artifactId));
        if (!existing || existing.checksum !== checksum) {
          throw new ConflictError("Duplicate compile result does not match the accepted Artifact.", "compile_result_conflict");
        }
        await tx.update(outboxEvents).set({ processedAt: new Date() }).where(eq(outboxEvents.id, input.compileId));
        return existing;
      }
      if (version.status !== "compiling") {
        throw new ConflictError(`Guardrail version is already ${version.status}.`, "stale_compile_result");
      }
      const [validation] = await tx.select({ id: validationRuns.id }).from(validationRuns).where(and(
        eq(validationRuns.guardrailId, input.guardrailId),
        eq(validationRuns.guardrailVersion, input.guardrailVersion),
        eq(validationRuns.sourceDraftRevision, version.sourceDraftRevision),
        eq(validationRuns.status, "passed"),
      )).limit(1);
      if (!validation) {
        throw new ConflictError("This compiled version has no passed Validation for its source draft.", "guardrail_validation_required");
      }
      const inserted = await tx.insert(artifacts).values({
        id: proposedArtifactId,
        guardrailId: input.guardrailId,
        guardrailVersion: input.guardrailVersion,
        generation: input.generation,
        compilerVersion: input.compilerVersion,
        nemoVersion: input.nemoVersion,
        runtimeProfile: input.runtimeProfile,
        plan: input.plan,
        configYaml: input.configYaml,
        colangContent: input.colangContent,
        prompts: input.prompts,
        actionBindings: input.actionBindings,
        dependencyManifest: input.dependencyManifest,
        checksum,
        signature,
      }).onConflictDoNothing().returning();
      const artifact = inserted[0] ?? (await tx.select().from(artifacts).where(eq(artifacts.checksum, checksum)))[0];
      if (!artifact || artifact.guardrailId !== input.guardrailId || artifact.guardrailVersion !== input.guardrailVersion) {
        throw new ConflictError("Artifact checksum is already bound to different content.", "artifact_checksum_conflict");
      }
      await tx.update(guardrailVersions).set({ status: "ready", artifactId: artifact.id, failureReason: null })
        .where(and(eq(guardrailVersions.guardrailId, input.guardrailId), eq(guardrailVersions.version, input.guardrailVersion)));
      const activated = guardrail.desiredGeneration === input.generation;
      if (activated) {
        await tx.update(guardrails).set({
          status: "active",
          activeVersion: input.guardrailVersion,
          activeArtifactId: artifact.id,
          desiredGeneration: input.generation,
          updatedAt: new Date(),
        }).where(eq(guardrails.id, input.guardrailId));
        await tx.update(routers).set({
          guardrailVersion: input.guardrailVersion,
          updatedAt: new Date(),
        }).where(and(eq(routers.guardrailId, input.guardrailId), isNull(routers.deletedAt)));
        if (input.guardrailId === DEFAULT_GUARDRAIL_ID) {
          await this.ensureDefaultRouter(tx, input.guardrailVersion);
        }
      }
      // Compile-request generation may already have been reconciled without
      // this artifact. Publishing new ready content needs a distinct delivery
      // generation, including a late version retained for default-pool tools.
      // Keep the signed artifact's compile generation and activation ordering.
      const [delivery] = await tx.update(controllerState).set({
        desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date(),
      }).where(eq(controllerState.id, "singleton")).returning();
      if (!delivery) throw new Error("Controller desired state is unavailable.");
      await tx.insert(outboxEvents).values({
        id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: input.guardrailId,
        payload: { guardrailId: input.guardrailId, generation: delivery.desiredGeneration, artifactId: artifact.id },
      });
      await tx.update(outboxEvents).set({ processedAt: new Date() }).where(eq(outboxEvents.id, input.compileId));
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.compiled", actorId: null,
        resourceType: "guardrail", resourceId: input.guardrailId,
        detail: { version: input.guardrailVersion, generation: input.generation, deliveryGeneration: delivery.desiredGeneration, artifactId: artifact.id, checksum, activated },
      });
      return artifact;
    });
    return { artifactId: stored.id, checksum: stored.checksum, signature: stored.signature };
  }

  async rejectCompile(input: { compileId: string; guardrailId: string; guardrailVersion: string; reason: string }) {
    await this.db.transaction(async (tx) => {
      await tx.update(guardrailVersions).set({ status: "failed", failureReason: input.reason })
        .where(and(eq(guardrailVersions.guardrailId, input.guardrailId), eq(guardrailVersions.version, input.guardrailVersion)));
      await tx.update(outboxEvents).set({ processedAt: new Date() }).where(eq(outboxEvents.id, input.compileId));
      const [guardrail] = await tx.select().from(guardrails).where(eq(guardrails.id, input.guardrailId));
      if (guardrail && !guardrail.activeArtifactId) {
        await tx.update(guardrails).set({ status: "draft", updatedAt: new Date() }).where(eq(guardrails.id, input.guardrailId));
      }
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.compile_failed", actorId: null,
        resourceType: "guardrail", resourceId: input.guardrailId,
        detail: { version: input.guardrailVersion, reason: input.reason },
      });
    });
  }

  async deleteGuardrailVersion(input: { guardrailId: string; version: string; actorId: string }) {
    await this.db.transaction(async tx => {
      // Same lock ordering as composed Router publication: bindings, then resource.
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const [guardrail] = await tx.select().from(guardrails).where(and(eq(guardrails.id, input.guardrailId), isNull(guardrails.deletedAt))).for("update");
      if (!guardrail) throw new NotFoundError("Guardrail", input.guardrailId);
      const [version] = await tx.select().from(guardrailVersions).where(and(eq(guardrailVersions.guardrailId, input.guardrailId), eq(guardrailVersions.version, input.version)));
      if (!version) throw new NotFoundError("Guardrail version", input.version);
      if (guardrail.activeVersion === input.version || version.status === "compiling") throw new ConflictError("Active or compiling versions cannot be deleted.", "version_in_use");
      if (Date.now() - guardrail.updatedAt.getTime() < 300000) throw new ConflictError("Wait for the five-minute call retention window before deleting a version.", "version_in_use");
      const runners = await tx.select().from(runnerInstances).where(eq(runnerInstances.poolId, "default"));
      if (runners.some(r => r.appliedGeneration < guardrail.desiredGeneration || !r.lastHeartbeatAt || Date.now() - r.lastHeartbeatAt.getTime() >= 60000)) throw new ConflictError("Wait for Runner convergence before deleting a version.", "version_in_use");
      const references = (draft: { routes: Array<{ targets: Array<{ guardrailId: string; guardrailVersion?: string; versionStrategy?: string | undefined }> }> } | null) => draft?.routes.some(r => r.targets.some(t => t.guardrailId === input.guardrailId && (t.guardrailVersion === input.version || t.versionStrategy === "latest")));
      const current = await tx.select().from(trafficRouters).where(isNull(trafficRouters.deletedAt));
      const history = await tx.select().from(trafficRouterRevisions);
      const legacy = await tx.select().from(routers).where(and(eq(routers.guardrailId, input.guardrailId), eq(routers.guardrailVersion, input.version), isNull(routers.deletedAt)));
      if (legacy.length || current.some(r => references(r.draft) || references(r.activeSnapshot)) || history.some(r => references(r.snapshot))) throw new ConflictError("This version is referenced by Router drafts or published revisions. Remove those references first.", "version_in_use");
      const [pending] = await tx.select().from(routeAssignments).where(and(eq(routeAssignments.guardrailId, input.guardrailId), eq(routeAssignments.guardrailVersion, input.version), isNull(routeAssignments.completedAt), gte(routeAssignments.occurredAt, new Date(Date.now() - 300000)))).limit(1);
      if (pending) throw new ConflictError("This version has in-flight calls.", "version_in_use");
      await tx.insert(auditEvents).values({ id: randomUUID(), kind: "guardrail.version_deleted", actorId: input.actorId, resourceType: "guardrail", resourceId: input.guardrailId, detail: { version: input.version, artifactId: version.artifactId } });
      // Keep artifacts and telemetry: deleting a version must not purge evidence.
      await tx.delete(guardrailVersions).where(and(eq(guardrailVersions.guardrailId, input.guardrailId), eq(guardrailVersions.version, input.version)));
    });
  }

  async rollbackGuardrail(input: { guardrailId: string; version: string; actorId: string }) {
    return this.db.transaction(async (tx) => {
      const [guardrail] = await tx.select().from(guardrails).where(and(
        eq(guardrails.id, input.guardrailId), isNull(guardrails.deletedAt),
      )).for("update");
      if (!guardrail) throw new NotFoundError("Guardrail", input.guardrailId);
      const [version] = await tx.select().from(guardrailVersions).where(and(
        eq(guardrailVersions.guardrailId, input.guardrailId),
        eq(guardrailVersions.version, input.version),
        eq(guardrailVersions.status, "ready"),
      ));
      if (!version?.artifactId) throw new ConflictError("Only a ready immutable Guardrail Version can be activated.", "guardrail_version_not_ready");
      const [state] = await tx.update(controllerState)
        .set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton")).returning();
      if (!state) throw new Error("Controller state is not initialized.");
      await tx.update(guardrails).set({
        status: "active",
        activeVersion: input.version,
        activeArtifactId: version.artifactId,
        desiredGeneration: state.desiredGeneration,
        updatedAt: new Date(),
      }).where(eq(guardrails.id, input.guardrailId));
      await tx.update(routers).set({ guardrailVersion: input.version, updatedAt: new Date() })
        .where(and(eq(routers.guardrailId, input.guardrailId), isNull(routers.deletedAt)));
      await tx.insert(outboxEvents).values({
        id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: input.guardrailId,
        payload: { guardrailId: input.guardrailId, version: input.version, generation: state.desiredGeneration },
      });
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.version_activated", actorId: input.actorId,
        resourceType: "guardrail", resourceId: input.guardrailId,
        detail: { version: input.version, generation: state.desiredGeneration },
      });
      return version;
    });
  }

  async listTestCases(guardrailId: string) {
    const [guardrail] = await this.db.select({ excludedTestCaseIds: guardrails.excludedTestCaseIds, draftConfig: guardrails.draftConfig })
      .from(guardrails).where(and(eq(guardrails.id, guardrailId), isNull(guardrails.deletedAt)));
    if (!guardrail) throw new NotFoundError("Guardrail", guardrailId);
    const excluded = new Set(guardrail.excludedTestCaseIds);
    const rows = await this.db.select().from(testCases).where(eq(testCases.guardrailId, guardrailId))
      .orderBy(asc(testCases.origin), asc(testCases.name), asc(testCases.id));
    return applyValidationOverrides(rows, guardrail.draftConfig).map((item) => ({ ...item, excluded: excluded.has(item.id) }));
  }

  async createTestCase(input: {
    guardrailId: string;
    actorId: string;
    name: string;
    policyId: string;
    phase: "input" | "output";
    content: string;
    expectedDecision: "allow" | "block" | "transform" | "intervene";
    trustedInstruction: string;
    targetSource: "user_input" | "retrieved_content" | "tool_output" | "model_output";
    query: string;
    groundingSources: string[];
    expectedReasoningResult: string | null;
  }) {
    const id = `custom-${randomUUID()}`;
    const created = await this.db.transaction(async (tx) => {
      const [guardrail] = await tx.select().from(guardrails).where(and(
        eq(guardrails.id, input.guardrailId), isNull(guardrails.deletedAt),
      )).for("update");
      if (!guardrail) throw new NotFoundError("Guardrail", input.guardrailId);
      const [stored] = await tx.insert(testCases).values({
        id,
        guardrailId: input.guardrailId,
        name: input.name,
        policyId: input.policyId,
        phase: input.phase,
        content: input.content,
        expectedDecision: input.expectedDecision,
        origin: "custom",
        trustedInstruction: input.trustedInstruction,
        targetSource: input.targetSource,
        query: input.query,
        groundingSources: input.groundingSources,
        expectedReasoningResult: input.expectedReasoningResult,
        caseType: "custom",
        required: true,
        coveredRuleIds: [],
      }).returning();
      if (!stored) throw new Error("Test Case creation did not return the stored resource.");
      await tx.update(guardrails).set({ draftRevision: increment(guardrails.draftRevision), updatedAt: new Date() })
        .where(eq(guardrails.id, input.guardrailId));
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.test_case_created", actorId: input.actorId,
        resourceType: "guardrail", resourceId: input.guardrailId, detail: { testCaseId: id },
      });
      return stored;
    });
    return { ...created, excluded: false };
  }

  async deleteTestCase(input: { guardrailId: string; caseId: string; actorId: string }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [item] = await tx.select().from(testCases).where(and(eq(testCases.guardrailId, input.guardrailId), eq(testCases.id, input.caseId))).limit(1).for("update");
      if (!item) throw new NotFoundError("Test Case", input.caseId);
      if (item.origin !== "custom") throw new ValidationError("Only custom Test Cases can be deleted. Exclude inherited Policy cases instead.");
      await tx.delete(testCases).where(and(eq(testCases.guardrailId, item.guardrailId), eq(testCases.id, item.id)));
      await tx.update(guardrails).set({ draftRevision: increment(guardrails.draftRevision), updatedAt: new Date() })
        .where(eq(guardrails.id, item.guardrailId));
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.test_case_deleted", actorId: input.actorId,
        resourceType: "guardrail", resourceId: item.guardrailId, detail: { testCaseId: item.id },
      });
    });
  }

  async setTestCaseExcluded(input: { guardrailId: string; caseId: string; excluded: boolean; actorId: string }) {
    const stored = await this.db.transaction(async (tx) => {
      const [guardrail] = await tx.select().from(guardrails).where(and(
        eq(guardrails.id, input.guardrailId), isNull(guardrails.deletedAt),
      )).for("update");
      if (!guardrail) throw new NotFoundError("Guardrail", input.guardrailId);
      const [item] = await tx.select().from(testCases).where(and(
        eq(testCases.guardrailId, input.guardrailId), eq(testCases.id, input.caseId),
      ));
      if (!item) throw new NotFoundError("Test Case", input.caseId);
      if (item.origin !== "generated") throw new ValidationError("Only inherited Policy Test Cases can be excluded.");
      const excluded = new Set(guardrail.excludedTestCaseIds);
      if (input.excluded) excluded.add(input.caseId);
      else excluded.delete(input.caseId);
      await tx.update(guardrails).set({
        excludedTestCaseIds: [...excluded].sort(),
        draftRevision: increment(guardrails.draftRevision),
        updatedAt: new Date(),
      }).where(eq(guardrails.id, input.guardrailId));
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: input.excluded ? "guardrail.test_case_excluded" : "guardrail.test_case_restored",
        actorId: input.actorId, resourceType: "guardrail", resourceId: input.guardrailId,
        detail: { testCaseId: input.caseId },
      });
      return item;
    });
    return { ...stored, excluded: input.excluded };
  }

  async listValidationRuns(guardrailId?: string | undefined) {
    const query = this.db.select().from(validationRuns);
    return guardrailId
      ? query.where(eq(validationRuns.guardrailId, guardrailId)).orderBy(desc(validationRuns.createdAt))
      : query.orderBy(desc(validationRuns.createdAt));
  }

  async getValidationRun(id: string) {
    const [run] = await this.db.select().from(validationRuns).where(eq(validationRuns.id, id));
    if (!run) throw new NotFoundError("Validation Run", id);
    return run;
  }

  async requestValidation(input: { guardrailId: string; actorId: string; compilerAvailable: boolean }) {
    if (!input.compilerAvailable) {
      throw new ConflictError("A healthy GuardRails 0 Runner is required to validate Guardrail configurations.", "default_runner_unavailable");
    }
    return this.db.transaction(async (tx) => {
      const [guardrail] = await tx.select().from(guardrails).where(and(
        eq(guardrails.id, input.guardrailId), isNull(guardrails.deletedAt),
      )).for("update");
      if (!guardrail) throw new NotFoundError("Guardrail", input.guardrailId);
      return this.enqueueGuardrailValidation(tx, guardrail, input.actorId);
    });
  }

  /** Shared by user validation and the model-free baseline bootstrap. */
  private async enqueueGuardrailValidation(
    tx: Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0],
    guardrail: typeof guardrails.$inferSelect,
    actorId: string | null,
  ) {
      const rows = await tx.select().from(testCases).where(eq(testCases.guardrailId, guardrail.id));
      const excluded = new Set(guardrail.excludedTestCaseIds);
      const activeCases = applyValidationOverrides(rows, guardrail.draftConfig).filter((item) => !excluded.has(item.id));
      if (!activeCases.length) throw new ValidationError("Add at least one reviewed Test Case before running Validation.");
      const requestedAt = new Date();
      const candidateVersion = guardrailVersionId(requestedAt);
      const programmablePolicies = await this.resolveProgrammablePolicies(normalizeGuardrailDraft(guardrail.draftConfig));
      const plan = buildGuardrailPlan({
        guardrailId: guardrail.id,
        guardrailVersion: candidateVersion,
        draft: normalizeGuardrailDraft(guardrail.draftConfig),
        policies: this.policyCatalog().list(),
        programmablePolicies,
      });
      const runId = `validation-${randomUUID()}`;
      await tx.insert(validationRuns).values({
        id: runId,
        guardrailId: guardrail.id,
        guardrailVersion: candidateVersion,
        sourceDraftRevision: guardrail.draftRevision,
        status: "queued",
        metrics: emptyValidationMetrics(activeCases.length),
        results: [],
        excludedCaseIds: [...excluded],
        createdBy: actorId,
        createdAt: requestedAt,
      });
      await tx.insert(outboxEvents).values({
        id: runId,
        kind: "guardrail.validation_requested",
        aggregateId: guardrail.id,
        payload: {
          runId,
          guardrailId: guardrail.id,
          candidateVersion,
          sourceDraftRevision: guardrail.draftRevision,
          plan,
          runtimeProfile: guardrail.runtimeProfile,
          testCases: activeCases,
        },
      });
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.validation_requested", actorId,
        resourceType: "guardrail", resourceId: guardrail.id,
        detail: { runId, sourceDraftRevision: guardrail.draftRevision, testCaseCount: activeCases.length },
      });
      return (await tx.select().from(validationRuns).where(eq(validationRuns.id, runId)))[0]!;
  }

  private async assertValidatedPlan(
    tx: Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0],
    runId: string,
    plan: Record<string, unknown>,
    runtimeProfile: string,
  ): Promise<void> {
    // A revision number alone is insufficient: an installed Policy catalog or
    // compiler mapping may have changed since validation. Compare against the
    // exact durable request that the Runner validated, not a fresh reconstruction.
    const [request] = await tx.select().from(outboxEvents).where(and(
      eq(outboxEvents.id, runId), eq(outboxEvents.kind, "guardrail.validation_requested"),
    )).limit(1);
    const validated = request?.payload.plan;
    if (!validated || typeof validated !== "object" || Array.isArray(validated)
      || request?.payload.runtimeProfile !== runtimeProfile
      || stableJson(planToWire(validated as Record<string, unknown>)) !== stableJson(planToWire(plan))) {
      throw new ConflictError(
        "The executable configuration changed since Validation. Validate the current draft again before publishing.",
        "guardrail_validation_plan_changed",
      );
    }
  }

  async markValidationRunning(runId: string): Promise<void> {
    const policyUpdate = await this.db.update(policyValidationRuns).set({ status: "running" })
      .where(and(eq(policyValidationRuns.id, runId), eq(policyValidationRuns.status, "queued"))).returning({ id: policyValidationRuns.id });
    if (policyUpdate.length) return;
    await this.db.update(validationRuns).set({ status: "running" })
      .where(and(eq(validationRuns.id, runId), eq(validationRuns.status, "queued")));
  }

  async completeValidation(input: {
    runId: string;
    status: ValidationTerminalState;
    metrics: ValidationMetrics;
    results: ValidationCaseResult[];
    reason?: string | undefined;
  }): Promise<void> {
    const [policyRun] = await this.db.select().from(policyValidationRuns).where(eq(policyValidationRuns.id, input.runId));
    if (policyRun) {
      await this.db.transaction(async (tx) => {
        const [locked] = await tx.select().from(policyValidationRuns)
          .where(eq(policyValidationRuns.id, input.runId)).for("update");
        if (!locked || locked.status === "passed" || locked.status === "failed") return;
        const results = input.results.map(policyValidationResult);
        await tx.update(policyValidationRuns).set({
          status: input.status,
          results,
          failureReason: input.reason ?? null,
          completedAt: new Date(),
        }).where(eq(policyValidationRuns.id, input.runId));
        await tx.update(outboxEvents).set({ processedAt: new Date() }).where(eq(outboxEvents.id, input.runId));
        await tx.insert(auditEvents).values({
          id: randomUUID(), kind: "policy.validation_completed", actorId: null,
          resourceType: "policy", resourceId: locked.policyId,
          detail: { runId: input.runId, status: input.status, passed: results.filter((item) => item.passed).length, total: results.length },
        });
      });
      return;
    }
    let resumeDefault = false;
    await this.db.transaction(async (tx) => {
      const [run] = await tx.select().from(validationRuns).where(eq(validationRuns.id, input.runId)).for("update");
      if (!run) throw new NotFoundError("Validation Run", input.runId);
      resumeDefault = run.guardrailId === DEFAULT_GUARDRAIL_ID && run.createdBy === null && input.status === "passed";
      if (run.status === "passed" || run.status === "failed") return;
      await tx.update(validationRuns).set({
        status: input.status,
        metrics: input.metrics,
        results: input.results,
        failureReason: input.reason ?? null,
        completedAt: new Date(),
      }).where(eq(validationRuns.id, input.runId));
      await tx.update(outboxEvents).set({ processedAt: new Date() }).where(eq(outboxEvents.id, input.runId));
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.validation_completed", actorId: null,
        resourceType: "guardrail", resourceId: run.guardrailId,
        detail: { runId: input.runId, status: input.status, complianceRate: input.metrics.complianceRate },
      });
    });
    // Reconcile after committing the result. Initialization is idempotent and
    // will re-check the current revision/customization before requesting a
    // compile; a late result must never publish a newer, untested draft.
    if (resumeDefault) await this.initialize();
  }

  async rejectValidation(input: { runId: string; reason: string }): Promise<void> {
    const [policyRun] = await this.db.select().from(policyValidationRuns).where(eq(policyValidationRuns.id, input.runId));
    if (policyRun) {
      await this.completeValidation({
        runId: input.runId,
        status: "failed",
        metrics: emptyValidationMetrics(0),
        results: [],
        reason: input.reason,
      });
      return;
    }
    const [run] = await this.db.select().from(validationRuns).where(eq(validationRuns.id, input.runId));
    if (!run) throw new NotFoundError("Validation Run", input.runId);
    await this.completeValidation({
      runId: input.runId,
      status: "failed",
      metrics: run.metrics,
      results: run.results,
      reason: input.reason,
    });
  }

  async guardrailLogging(id: string) {
    const [guardrail] = await this.db.select({ id: guardrails.id, level: guardrails.loggingLevel, updatedAt: guardrails.updatedAt })
      .from(guardrails).where(and(eq(guardrails.id, id), isNull(guardrails.deletedAt)));
    if (!guardrail) throw new NotFoundError("Guardrail", id);
    return { ...guardrail, contentCaptureEnabled: this.runtimeLogEncryptionKey !== null, retentionDays: 30 };
  }

  async updateGuardrailLogging(input: { id: string; level: "info" | "debug" | "trace"; actorId: string }) {
    const [updated] = await this.db.transaction(async (tx) => {
      const rows = await tx.update(guardrails).set({ loggingLevel: input.level, updatedAt: new Date() })
        .where(and(eq(guardrails.id, input.id), isNull(guardrails.deletedAt))).returning({ id: guardrails.id, level: guardrails.loggingLevel });
      if (!rows[0]) throw new NotFoundError("Guardrail", input.id);
      const [state] = await tx.update(controllerState)
        .set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton")).returning();
      if (!state) throw new Error("Controller state is not initialized.");
      await tx.update(guardrails).set({ desiredGeneration: state.desiredGeneration })
        .where(eq(guardrails.id, input.id));
      await tx.insert(outboxEvents).values({
        id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: input.id,
        payload: { guardrailId: input.id, loggingLevel: input.level, generation: state.desiredGeneration },
      });
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.logging_updated", actorId: input.actorId,
        resourceType: "guardrail", resourceId: input.id, detail: { level: input.level },
      });
      return rows;
    });
    return { ...updated, contentCaptureEnabled: this.runtimeLogEncryptionKey !== null, retentionDays: 30 };
  }

  async listEndpoints() {
    const rows = await this.db.select().from(endpoints)
      .where(isNull(endpoints.deletedAt)).orderBy(desc(endpoints.updatedAt));
    return rows.map((endpoint) => this.publicEndpoint(endpoint));
  }

  async getEndpoint(id: string) {
    const [endpoint] = await this.db.select().from(endpoints)
      .where(and(eq(endpoints.id, id), isNull(endpoints.deletedAt)));
    if (!endpoint) throw new NotFoundError("Endpoint", id);
    return this.publicEndpoint(endpoint);
  }

  async listRouters() {
    const rows = await this.db.select({ router: routers }).from(routers)
      .leftJoin(endpoints, eq(routers.endpointId, endpoints.id))
      .where(and(
        isNull(routers.deletedAt),
        or(
          isNull(routers.endpointId),
          and(isNotNull(endpoints.id), isNull(endpoints.deletedAt)),
        ),
      ))
      .orderBy(asc(routers.endpointId), asc(routers.routeOrder), asc(routers.id));
    return rows.map((row) => row.router);
  }

  async getRouter(id: string) {
    const [router] = await this.db.select().from(routers)
      .where(and(eq(routers.id, id), isNull(routers.deletedAt)));
    if (!router) throw new NotFoundError("Router", id);
    return router;
  }

  async listRuntimeEvents(limit = 100) {
    return (await this.queryRuntimeEvents({ limit })).items;
  }

  private metricCache = new Map<string, { until: number; value: Awaited<ReturnType<typeof queryRuntimeMetrics>> }>();
  private metricJobs = new Map<string, ReturnType<typeof queryRuntimeMetrics>>();
  async runtimeMetrics(scope: MetricScope) {
    const key = JSON.stringify([scope.window, scope.guardrailId ?? null, scope.routerId ?? null]);
    const cached = this.metricCache.get(key);
    if (cached && cached.until > Date.now()) return cached.value;
    const pending = this.metricJobs.get(key);
    if (pending) return pending;
    if (this.metricJobs.size >= 2) throw new ConflictError("Metrics are busy; retry shortly.", "metrics_busy");
    const job = queryRuntimeMetrics(this.db, scope);
    this.metricJobs.set(key, job);
    try {
      const value = await job;
      if (this.metricCache.size >= 16) this.metricCache.delete(this.metricCache.keys().next().value!);
      this.metricCache.set(key, { until: Date.now() + 10_000, value });
      return value;
    } finally { this.metricJobs.delete(key); }
  }

  async getRuntimeEvent(id: string, includeContent = false) {
    const [item] = await boundedRead(this.db, tx => tx.select().from(runtimeEvents).where(eq(runtimeEvents.id, id)).limit(1));
    if (!item) throw new NotFoundError("Runtime event", id);
    const { contentCiphertext: _ciphertext, contentBefore: _before, contentAfter: _after, ...safe } = item.metadata;
    return { ...item, metadata: includeContent ? decryptRuntimeEventMetadata(item.metadata, this.runtimeLogEncryptionKey) : safe };
  }

  private endpointActivityCache?: { until: number; value: { items: Record<string, unknown>[] } };
  private endpointActivityJob: Promise<{ items: Record<string, unknown>[] }> | undefined;
  async runtimeEndpointActivity() {
    if (this.endpointActivityCache && this.endpointActivityCache.until > Date.now()) return this.endpointActivityCache.value;
    if (this.endpointActivityJob) return this.endpointActivityJob;
    const job = boundedRead(this.db, async tx => {
      // Lifetime timestamps are index probes; only recent counters scan a time window.
      const scope = eq(runtimeEvents.endpointId, endpoints.id);
      const errors = inArray(lowerText(runtimeEvents.decision), ['error','failed','failure','timeout','timed_out']);
      const timestamp = (name: string, filter?: SQL, oldest = false) => tx
        .select({ at: runtimeEvents.occurredAt }).from(runtimeEvents)
        .where(and(scope, filter))
        .orderBy(oldest ? asc(runtimeEvents.occurredAt) : desc(runtimeEvents.occurredAt))
        .limit(1).as(name);
      const first = timestamp('first_activity', undefined, true);
      const last = timestamp('last_activity');
      const incoming = timestamp('incoming_activity', eq(runtimeEvents.direction, 'incoming'));
      const outgoing = timestamp('outgoing_activity', eq(runtimeEvents.direction, 'outgoing'));
      const finalCheck = timestamp('final_activity', eq(jsonText(runtimeEvents.metadata, 'streamFinalCheck'), 'true'));
      const lastError = timestamp('error_activity', errors);
      const recentScope = and(scope, gte(runtimeEvents.occurredAt, new Date(Date.now() - 86_400_000)));
      const recent = tx.select({
        total: countDistinct(runtimeEvents.requestId).as('recent_request_count'),
        p95: sql<number | null>`percentile_disc(0.95) within group (order by ${runtimeEvents.durationMs}) filter (where ${runtimeEvents.durationMs} >= 0)`.as('recent_p95_ms'),
      })
        .from(runtimeEvents).where(recentScope).as('recent_activity');
      // A request can emit input/output events and multiple failures. Count it once.
      const recentErrors = tx.select({ total: countDistinct(runtimeEvents.requestId).as('recent_error_count') })
        .from(runtimeEvents).where(and(recentScope, errors)).as('recent_errors');
      const join = eq(endpoints.id, endpoints.id);
      const items = await tx.select({
        id: endpoints.id, first_seen_at: first.at, last_seen_at: last.at,
        input_seen_at: incoming.at, output_seen_at: outgoing.at,
        stream_final_check_seen_at: finalCheck.at, last_error_at: lastError.at,
        request_count: recent.total, error_count: recentErrors.total, detection_p95_ms: recent.p95,
      }).from(endpoints)
        .leftJoinLateral(first, join).leftJoinLateral(last, join)
        .leftJoinLateral(incoming, join).leftJoinLateral(outgoing, join)
        .leftJoinLateral(finalCheck, join).leftJoinLateral(lastError, join)
        .innerJoinLateral(recent, join).innerJoinLateral(recentErrors, join)
        .where(isNull(endpoints.deletedAt));
      return { items };
    });
    this.endpointActivityJob = job;
    try {
      const value = await job;
      this.endpointActivityCache = { until: Date.now() + 10_000, value };
      return value;
    } finally { this.endpointActivityJob = undefined; }
  }

  async queryRuntimeEvents(input: {
    limit?: number | undefined;
    guardrailId?: string | undefined;
    routerId?: string | undefined;
    routeId?: string | undefined;
    targetId?: string | undefined;
    routerRevision?: number | undefined;
    endpointId?: string | undefined;
    since?: Date | undefined;
    before?: Date | undefined;
    cursor?: string | undefined;
    requestId?: string | undefined;
    direction?: string | undefined;
    outcome?: string | undefined;
    captured?: boolean | undefined;
    findingsOnly?: boolean | undefined;
    severity?: 'critical' | 'high' | 'medium' | 'low' | undefined;
  }) {
    let cursor: { at: string; id: string } | undefined;
    if (input.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
        if (!cursor || typeof cursor.at !== 'string' || !Number.isFinite(Date.parse(cursor.at)) || typeof cursor.id !== 'string') throw new Error();
      } catch { throw new ValidationError("Invalid event cursor"); }
    }
    const findings = jsonElements(jsonValue(runtimeEvents.metadata, 'findings'), 'finding');
    const conditions = [
      input.severity ? exists(this.db.select({ severity: findingSeverity(findings.item) }).from(findings.source).where(eq(findingSeverity(findings.item), input.severity))) : undefined,
      cursor ? lt(rowValue(runtimeEvents.occurredAt, runtimeEvents.id), rowValue(timestampValue(cursor.at), literal(cursor.id))) : undefined,
      input.requestId ? eq(runtimeEvents.requestId, input.requestId) : undefined,
      input.direction ? eq(runtimeEvents.direction, input.direction) : undefined,
      input.outcome ? inArray(lowerText(runtimeEvents.decision), input.outcome === 'allow' ? ['allow','allowed','pass','passed'] : input.outcome === 'block' ? ['block','blocked','reject','rejected','deny','denied'] : input.outcome === 'transform' ? ['transform','transformed','redact','redacted','rewrite','rewritten','intervene','intervened'] : ['error','failed','failure','timeout','timed_out']) : undefined,
      input.captured ? eq(jsonText(runtimeEvents.metadata, 'runtimeLogCaptured'), 'true') : undefined,
      input.findingsOnly ? gt(jsonArrayLength(jsonValue(runtimeEvents.metadata, 'findings')), 0) : undefined,
      input.guardrailId ? eq(runtimeEvents.guardrailId, input.guardrailId) : undefined,
      input.routerId ? eq(runtimeEvents.routerId, input.routerId) : undefined,
      input.routeId ? eq(jsonText(runtimeEvents.metadata, "routeId"), input.routeId) : undefined,
      input.targetId ? eq(jsonText(runtimeEvents.metadata, "targetId"), input.targetId) : undefined,
      input.routerRevision ? eq(jsonText(runtimeEvents.metadata, "routerRevision"), String(input.routerRevision)) : undefined,
      input.endpointId ? eq(runtimeEvents.endpointId, input.endpointId) : undefined,
      input.since ? gte(runtimeEvents.occurredAt, input.since) : undefined,
      input.before ? lte(runtimeEvents.occurredAt, input.before) : undefined,
    ].filter((item): item is NonNullable<typeof item> => Boolean(item));
    const predicate = conditions.length ? and(...conditions) : undefined;
    // SQL projection is essential: discarding metadata after SELECT still allocates the full payload in Node.
    return boundedRead(this.db, async tx => {
    const findingSummary = jsonObject(Object.fromEntries(['id','risk','verdict','confidence','taxonomyId','recommendedAction','policyId','ruleId'].map(key => [key, jsonValue(findings.item, key)])));
    const metadata = jsonObject({
      ...Object.fromEntries(['captureLevel','runtimeLogCaptured','protocol','action','timedOut','timed_out','streamFinalCheck','routeId','targetId','routerRevision','decisionId'].map(key => [key,jsonValue(runtimeEvents.metadata, key)])),
      findings: scalar(tx.select({ value: jsonAggregate(findingSummary) }).from(findings.source)),
    });
    let itemsQuery = tx.select({
      id: runtimeEvents.id, occurredAt: runtimeEvents.occurredAt,
      cursorAt: asText(runtimeEvents.occurredAt), requestId: runtimeEvents.requestId,
      runnerId: runtimeEvents.runnerId, guardrailId: runtimeEvents.guardrailId, guardrailVersion: runtimeEvents.guardrailVersion,
      endpointId: runtimeEvents.endpointId, routerId: runtimeEvents.routerId,
      direction: runtimeEvents.direction, decision: runtimeEvents.decision, durationMs: runtimeEvents.durationMs,
      metadata,
    }).from(runtimeEvents).$dynamic();
    if (predicate) {
      itemsQuery = itemsQuery.where(predicate);
    }
    const limit = Math.min(500, Math.max(1, input.limit ?? 100));
    const rows = await itemsQuery.orderBy(desc(runtimeEvents.occurredAt), desc(runtimeEvents.id)).limit(limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(({ cursorAt: _at, ...item }) => item),
      count: items.length,
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({at:last.cursorAt,id:last.id})).toString('base64url') : null,
    };
    });
  }

  async listAuditEvents(limit = 100) {
    return this.db.select().from(auditEvents).orderBy(desc(auditEvents.occurredAt)).limit(limit);
  }

  async createRouter(input: {
    name: string;
    guardrailId: string;
    endpointId: string;
    poolId: string;
    trafficScope: Record<string, unknown>;
    enabled?: boolean | undefined;
    actorId: string;
  }) {
    const created = await this.createRouterBindings({
      ...input,
      endpointIds: [input.endpointId],
    });
    return created[0]!;
  }

  async createRouterBindings(input: {
    name: string;
    guardrailId: string;
    endpointIds: string[];
    poolId: string;
    trafficScope: Record<string, unknown>;
    enabled?: boolean | undefined;
    actorId: string;
  }) {
    const uniqueEndpointIds = [...new Set(input.endpointIds)];
    if (!uniqueEndpointIds.length) throw new ValidationError("Select at least one Endpoint for a Router.");
    return this.db.transaction(async (tx) => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const [guardrail] = await tx.select().from(guardrails).where(and(
        eq(guardrails.id, input.guardrailId), eq(guardrails.status, "active"), isNull(guardrails.deletedAt),
      ));
      if (!guardrail?.activeArtifactId || !guardrail.activeVersion) {
        throw new ConflictError("Only a compiled active Guardrail can be deployed.", "guardrail_not_active");
      }
      const [pool] = await tx.select().from(runnerPools).where(eq(runnerPools.id, input.poolId));
      if (!pool) throw new NotFoundError("Runner Pool", input.poolId);
      for (const endpointId of [...uniqueEndpointIds].sort()) {
        await advisoryTransactionLock(tx, endpointId);
      }
      const endpointRows = await tx.select().from(endpoints).where(and(
        inArray(endpoints.id, uniqueEndpointIds), eq(endpoints.status, "active"), isNull(endpoints.deletedAt),
      ));
      const activeIds = new Set(endpointRows.map((item) => item.id));
      const missing = uniqueEndpointIds.filter((id) => !activeIds.has(id));
      if (missing.length) throw new ValidationError(`Active Endpoints were not found: ${missing.join(", ")}.`);
      const created: Array<typeof routers.$inferSelect> = [];
      for (const endpointId of uniqueEndpointIds) {
        const routes = await tx.select().from(routers)
          .where(and(eq(routers.endpointId, endpointId), isNull(routers.deletedAt)))
          .orderBy(asc(routers.routeOrder), asc(routers.id)).for("update");
        assertCatchAllTopology(routes);
        const catchAll = routes.find((item) => isCatchAllTrafficScope(item.trafficScope));
        const insertingCatchAll = isCatchAllTrafficScope(input.trafficScope);
        if (insertingCatchAll && catchAll) {
          throw new ConflictError(
            "An Endpoint can have only one catch-all Router.",
            "router_catch_all_conflict",
          );
        }
        const routeOrder = !insertingCatchAll && catchAll
          ? catchAll.routeOrder
          : (routes.at(-1)?.routeOrder ?? -1) + 1;
        if (!insertingCatchAll && catchAll) {
          for (const route of [...routes].reverse()) {
            if (route.routeOrder < routeOrder) continue;
            await tx.update(routers).set({ routeOrder: route.routeOrder + 1 })
              .where(eq(routers.id, route.id));
          }
        }
        const id = randomUUID();
        const [row] = await tx.insert(routers).values({
          id,
          name: uniqueEndpointIds.length === 1 ? input.name : `${input.name} · ${endpointRows.find((item) => item.id === endpointId)?.name ?? endpointId}`,
          guardrailId: input.guardrailId,
          guardrailVersion: guardrail.activeVersion,
          endpointId,
          poolId: input.poolId,
          routeOrder,
          enabled: input.enabled ?? true,
          trafficScope: input.trafficScope,
        }).returning();
        if (!row) throw new Error("Router creation did not return the stored resource.");
        created.push(row);
      }
      const [state] = await tx.update(controllerState)
        .set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton")).returning();
      if (!state) throw new Error("Controller state is not initialized.");
      await tx.insert(outboxEvents).values({
        id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: input.guardrailId,
        payload: { routerIds: created.map((item) => item.id), generation: state.desiredGeneration },
      });
      await tx.insert(auditEvents).values(created.map((item) => ({
        id: randomUUID(), kind: "router.created", actorId: input.actorId,
        resourceType: "router", resourceId: item.id,
        detail: { guardrailId: input.guardrailId, endpointId: item.endpointId, poolId: input.poolId, routeOrder: item.routeOrder },
      })));
      return created;
    });
  }

  async setRouterEnabled(input: { id: string; enabled: boolean; actorId: string }) {
    return this.mutateRouter(input.id, input.actorId, input.enabled ? "router.enabled" : "router.disabled", async (tx, current) => {
      if (current.enabled === input.enabled) return current;
      const [updated] = await tx.update(routers).set({ enabled: input.enabled, updatedAt: new Date() })
        .where(eq(routers.id, input.id)).returning();
      return updated!;
    });
  }

  async updateRouterTrafficScope(input: { id: string; trafficScope: Record<string, unknown>; actorId: string }) {
    return this.mutateRouter(input.id, input.actorId, "router.traffic_scope_updated", async (tx, current) => {
      if (!current.endpointId) throw new ValidationError("The global fallback Router is system managed.");
      await advisoryTransactionLock(tx, current.endpointId);
      const routes = await tx.select().from(routers)
        .where(and(eq(routers.endpointId, current.endpointId), isNull(routers.deletedAt)))
        .orderBy(asc(routers.routeOrder), asc(routers.id)).for("update");
      assertCatchAllTopology(routes.map((route) => route.id === input.id
        ? { ...route, trafficScope: input.trafficScope }
        : route));
      const [updated] = await tx.update(routers).set({ trafficScope: input.trafficScope, updatedAt: new Date() })
        .where(eq(routers.id, input.id)).returning();
      return updated!;
    });
  }

  async reorderRouterRoutes(input: { endpointId: string; routerIds: string[]; actorId: string }) {
    if (new Set(input.routerIds).size !== input.routerIds.length) throw new ValidationError("Router route order contains duplicate IDs.");
    return this.db.transaction(async (tx) => {
      await advisoryTransactionLock(tx, input.endpointId);
      const current = await tx.select().from(routers)
        .where(and(eq(routers.endpointId, input.endpointId), isNull(routers.deletedAt)))
        .orderBy(asc(routers.routeOrder), asc(routers.id)).for("update");
      const expected = new Set(current.map((item) => item.id));
      if (current.length !== input.routerIds.length || input.routerIds.some((id) => !expected.has(id))) {
        throw new ConflictError("Route order must include every Router for the Endpoint exactly once.", "router_order_conflict");
      }
      const byId = new Map(current.map((item) => [item.id, item]));
      assertCatchAllTopology(input.routerIds.map((id, routeOrder) => ({ ...byId.get(id)!, routeOrder })));
      for (const item of current) {
        await tx.update(routers).set({ routeOrder: -item.routeOrder - 1 }).where(eq(routers.id, item.id));
      }
      for (const [routeOrder, id] of input.routerIds.entries()) {
        await tx.update(routers).set({ routeOrder, updatedAt: new Date() }).where(eq(routers.id, id));
      }
      await this.advanceRouterDesiredState(tx, input.endpointId, input.actorId, "router.routes_reordered", {
        routerIds: input.routerIds,
      });
      return tx.select().from(routers)
        .where(and(eq(routers.endpointId, input.endpointId), isNull(routers.deletedAt)))
        .orderBy(asc(routers.routeOrder), asc(routers.id));
    });
  }

  async createEndpoint(input: { name: string; adapter: string; actorId: string }) {
    const id = randomUUID();
    const issued = issueEndpointCredential();
    const verification = { credentials: [issued.stored] };
    const [created] = await this.db.transaction(async (tx) => {
      const rows = await tx.insert(endpoints).values({
        id, name: input.name, adapter: input.adapter, verification,
      }).returning();
      await this.advanceEndpointDesiredState(tx, {
        endpointId: id,
        actorId: input.actorId,
        auditKind: "endpoint.created",
        auditDetail: { name: input.name, adapter: input.adapter, credentialId: issued.stored.id },
      });
      if (!rows[0]) throw new Error("Endpoint creation did not return the stored resource.");
      return rows;
    });
    if (!created) throw new Error("Endpoint creation did not return the stored resource.");
    return {
      ...this.publicEndpoint(created),
      credential: issued.value,
      credentialId: issued.publicCredential.id,
      credentialKeyHint: issued.publicCredential.keyHint,
      credentialCreatedAt: issued.publicCredential.createdAt,
    };
  }

  async setEndpointEnabled(input: { id: string; enabled: boolean; actorId: string }) {
    return this.db.transaction(async (tx) => {
      const [endpoint] = await tx.select().from(endpoints)
        .where(and(eq(endpoints.id, input.id), isNull(endpoints.deletedAt))).for("update");
      if (!endpoint) throw new NotFoundError("Endpoint", input.id);
      const status = input.enabled ? "active" : "disabled";
      if (endpoint.status === status) return this.publicEndpoint(endpoint);

      const now = new Date();
      const [updated] = await tx.update(endpoints).set({ status, updatedAt: now })
        .where(and(eq(endpoints.id, input.id), isNull(endpoints.deletedAt))).returning();
      if (!updated) throw new NotFoundError("Endpoint", input.id);
      await this.advanceEndpointDesiredState(tx, {
        endpointId: input.id,
        actorId: input.actorId,
        auditKind: input.enabled ? "endpoint.enabled" : "endpoint.disabled",
        auditDetail: { previousStatus: endpoint.status, status },
      });
      return this.publicEndpoint(updated);
    });
  }

  async rotateEndpointCredential(input: { id: string; actorId: string }) {
    const issued = issueEndpointCredential();
    const updated = await this.db.transaction(async (tx) => {
      const [endpoint] = await tx.select().from(endpoints)
        .where(and(eq(endpoints.id, input.id), isNull(endpoints.deletedAt))).for("update");
      if (!endpoint) throw new NotFoundError("Endpoint", input.id);
      const verification = appendEndpointCredential(endpoint.verification, issued.stored);
      const [stored] = await tx.update(endpoints).set({ verification, updatedAt: new Date() })
        .where(and(eq(endpoints.id, input.id), isNull(endpoints.deletedAt))).returning();
      if (!stored) throw new NotFoundError("Endpoint", input.id);
      await this.advanceEndpointDesiredState(tx, {
        endpointId: input.id,
        actorId: input.actorId,
        auditKind: "endpoint.credential_rotated",
        auditDetail: { credentialId: issued.stored.id, keyHint: issued.stored.keyHint },
      });
      return stored;
    });
    return {
      ...this.publicEndpoint(updated),
      credential: issued.value,
      credentialId: issued.publicCredential.id,
      credentialKeyHint: issued.publicCredential.keyHint,
      credentialCreatedAt: issued.publicCredential.createdAt,
    };
  }

  async revokeEndpointCredential(input: { id: string; credentialId: string; actorId: string }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [endpoint] = await tx.select().from(endpoints)
        .where(and(eq(endpoints.id, input.id), isNull(endpoints.deletedAt))).for("update");
      if (!endpoint) throw new NotFoundError("Endpoint", input.id);
      const activeCredentials = activeEndpointCredentials(endpoint.verification);
      if (!activeCredentials.some((credential) => credential.id === input.credentialId)) {
        throw new NotFoundError("Endpoint credential", input.credentialId);
      }
      if (activeCredentials.length === 1) {
        throw new ConflictError(
          "An Endpoint must retain at least one active credential.",
          "last_endpoint_credential",
        );
      }
      const verification = revokeEndpointCredential(endpoint.verification, input.credentialId, new Date());
      if (!verification) throw new NotFoundError("Endpoint credential", input.credentialId);
      const updated = await tx.update(endpoints).set({ verification, updatedAt: new Date() })
        .where(and(eq(endpoints.id, input.id), isNull(endpoints.deletedAt))).returning({ id: endpoints.id });
      if (!updated[0]) throw new NotFoundError("Endpoint", input.id);
      await this.advanceEndpointDesiredState(tx, {
        endpointId: input.id,
        actorId: input.actorId,
        auditKind: "endpoint.credential_revoked",
        auditDetail: { credentialId: input.credentialId },
      });
    });
  }

  async guardrailDeletionImpact(id: string): Promise<DeletionImpact> {
    if (id === DEFAULT_GUARDRAIL_ID) {
      throw new ValidationError("The Default Guardrail cannot be removed because it protects unmatched traffic.");
    }
    const [resource] = await this.db.select().from(guardrails).where(and(eq(guardrails.id, id), isNull(guardrails.deletedAt)));
    if (!resource) throw new NotFoundError("Guardrail", id);
    const activeRouters = await this.db.select({ poolId: routers.poolId }).from(routers)
      .where(and(eq(routers.guardrailId, id), eq(routers.enabled, true), isNull(routers.deletedAt)));
    return this.deletionImpact("guardrail", id, activeRouters.map((item) => item.poolId));
  }

  async endpointDeletionImpact(id: string): Promise<DeletionImpact> {
    const [resource] = await this.db.select().from(endpoints).where(and(eq(endpoints.id, id), isNull(endpoints.deletedAt)));
    if (!resource) throw new NotFoundError("Endpoint", id);
    const activeRouters = await this.db.select({ poolId: routers.poolId }).from(routers)
      .where(and(eq(routers.endpointId, id), eq(routers.enabled, true), isNull(routers.deletedAt)));
    return this.deletionImpact("endpoint", id, activeRouters.map((item) => item.poolId));
  }

  async softDeleteGuardrail(input: { id: string; actorId: string; reason: string; confirmRecentTraffic: boolean; confirmationName?: string | undefined }) {
    if (input.id === DEFAULT_GUARDRAIL_ID) {
      throw new ValidationError("The Default Guardrail cannot be removed because it protects unmatched traffic.");
    }
    const [resource] = await this.db.select({ name: guardrails.name }).from(guardrails)
      .where(and(eq(guardrails.id, input.id), isNull(guardrails.deletedAt)));
    if (!resource) throw new NotFoundError("Guardrail", input.id);
    const impact = await this.guardrailDeletionImpact(input.id);
    this.assertDeletionAllowed(impact, input.confirmRecentTraffic, input.confirmationName, resource.name);
    await this.db.transaction(async (tx) => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      await this.trafficRouting.assertGuardrailUnused(input.id, tx);
      const [state] = await tx.update(controllerState)
        .set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton")).returning();
      if (!state) throw new Error("Controller state is not initialized.");
      const disabled = await tx.update(guardrails).set({
        status: "disabled", deletedAt: new Date(), deletedBy: input.actorId,
        deleteReason: input.reason, desiredGeneration: state.desiredGeneration, updatedAt: new Date(),
      }).where(and(eq(guardrails.id, input.id), isNull(guardrails.deletedAt))).returning({ id: guardrails.id });
      if (!disabled[0]) throw new NotFoundError("Guardrail", input.id);
      await tx.update(routers).set({ enabled: false, updatedAt: new Date() })
        .where(and(eq(routers.guardrailId, input.id), isNull(routers.deletedAt)));
      await this.recordSoftDelete(tx, "guardrail", input, impact, state.desiredGeneration);
    });
  }

  async softDeleteEndpoint(input: { id: string; actorId: string; reason: string; confirmRecentTraffic: boolean; confirmationName?: string | undefined }) {
    const [resource] = await this.db.select({ name: endpoints.name }).from(endpoints)
      .where(and(eq(endpoints.id, input.id), isNull(endpoints.deletedAt)));
    if (!resource) throw new NotFoundError("Endpoint", input.id);
    const impact = await this.endpointDeletionImpact(input.id);
    this.assertDeletionAllowed(impact, input.confirmRecentTraffic, input.confirmationName, resource.name);
    await this.db.transaction(async (tx) => {
      const [state] = await tx.update(controllerState)
        .set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton")).returning();
      if (!state) throw new Error("Controller state is not initialized.");
      const disabled = await tx.update(endpoints).set({
        status: "disabled", deletedAt: new Date(), deletedBy: input.actorId,
        deleteReason: input.reason, updatedAt: new Date(),
      }).where(and(eq(endpoints.id, input.id), isNull(endpoints.deletedAt))).returning({ id: endpoints.id });
      if (!disabled[0]) throw new NotFoundError("Endpoint", input.id);
      await tx.update(routers).set({ enabled: false, updatedAt: new Date() })
        .where(and(eq(routers.endpointId, input.id), isNull(routers.deletedAt)));
      await this.recordSoftDelete(tx, "endpoint", input, impact, state.desiredGeneration);
    });
  }

  async routerDeletionImpact(id: string): Promise<DeletionImpact> {
    if (id === DEFAULT_ROUTER_ID) {
      throw new ValidationError("The Default Router cannot be removed because it protects unmatched traffic.");
    }
    const [resource] = await this.db.select({ poolId: routers.poolId, enabled: routers.enabled })
      .from(routers).where(and(eq(routers.id, id), isNull(routers.deletedAt)));
    if (!resource) throw new NotFoundError("Router", id);
    return this.deletionImpact("router", id, resource.enabled ? [resource.poolId] : []);
  }

  async softDeleteRouter(input: { id: string; actorId: string; reason: string; confirmRecentTraffic: boolean; confirmationName?: string | undefined }) {
    if (input.id === DEFAULT_ROUTER_ID) {
      throw new ValidationError("The Default Router cannot be removed because it protects unmatched traffic.");
    }
    const [resource] = await this.db.select({
      name: routers.name,
      endpointId: routers.endpointId,
      guardrailId: routers.guardrailId,
    }).from(routers).where(and(eq(routers.id, input.id), isNull(routers.deletedAt)));
    if (!resource) throw new NotFoundError("Router", input.id);
    const impact = await this.routerDeletionImpact(input.id);
    this.assertDeletionAllowed(impact, input.confirmRecentTraffic, input.confirmationName, resource.name);
    await this.db.transaction(async (tx) => {
      if (resource.endpointId) {
        await advisoryTransactionLock(tx, resource.endpointId);
      }
      const [state] = await tx.update(controllerState)
        .set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton")).returning();
      if (!state) throw new Error("Controller state is not initialized.");
      const deleted = await tx.update(routers).set({
        enabled: false,
        deletedAt: new Date(),
        deletedBy: input.actorId,
        deleteReason: input.reason,
        updatedAt: new Date(),
      }).where(and(eq(routers.id, input.id), isNull(routers.deletedAt))).returning({ id: routers.id });
      if (!deleted[0]) throw new NotFoundError("Router", input.id);
      await tx.insert(auditEvents).values({
        id: randomUUID(),
        kind: "router.deleted",
        actorId: input.actorId,
        resourceType: "router",
        resourceId: input.id,
        detail: {
          reason: input.reason,
          impact,
          generation: state.desiredGeneration,
          endpointId: resource.endpointId,
          guardrailId: resource.guardrailId,
        },
      });
      await tx.insert(outboxEvents).values({
        id: randomUUID(),
        kind: "runner.desired_state_changed",
        aggregateId: input.id,
        payload: {
          resourceType: "router",
          resourceId: input.id,
          generation: state.desiredGeneration,
          disabled: true,
        },
      });
    });
  }

  async recordRuntimeEvents(events: readonly RuntimeEventInput[]): Promise<void> {
    if (events.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const event of events) {
        await tx.insert(runtimeEvents).values({
          id: event.id,
          occurredAt: event.occurredAt,
          requestId: event.requestId,
          runnerId: event.runnerId,
          guardrailId: event.guardrailId ?? null,
          guardrailVersion: event.guardrailVersion ?? null,
          endpointId: event.endpointId ?? null,
          routerId: event.routerId ?? null,
          direction: event.direction,
          decision: event.decision,
          durationMs: event.durationMs,
          metadata: event.metadata,
        }).onConflictDoNothing();
        await tx.insert(telemetryWatermarks).values({
          runnerId: event.runnerId, lastEventOccurredAt: event.occurredAt, lastReceivedAt: new Date(), updatedAt: new Date(),
        }).onConflictDoUpdate({
          target: telemetryWatermarks.runnerId,
          set: { lastEventOccurredAt: event.occurredAt, lastReceivedAt: new Date(), updatedAt: new Date() },
        });
      }
    });
  }

  async recordTelemetryWatermark(runnerId: string): Promise<void> {
    const now = new Date();
    await this.db.insert(telemetryWatermarks).values({
      runnerId,
      lastEventOccurredAt: null,
      lastReceivedAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: telemetryWatermarks.runnerId,
      set: { lastReceivedAt: now, updatedAt: now },
    });
  }

  async registerRunner(input: RunnerRegistration): Promise<number> {
    await this.db.insert(runnerPools).values({
      id: input.poolId,
      name: input.poolId === "default" ? "GuardRails 0" : input.poolId,
      isDefault: input.poolId === "default",
      desiredReplicas: input.poolId === "default" ? 2 : 1,
      safeRpsPerRunner: 50,
      maxConcurrencyPerRunner: input.maxConcurrency,
    }).onConflictDoNothing();
    const desiredGeneration = await this.desiredGeneration();
    await this.db.insert(runnerInstances).values({
      ...input,
      desiredGeneration,
      status: input.appliedGeneration === desiredGeneration ? "ready" : "syncing",
      heartbeatSequence: 0,
      connectedAt: new Date(),
      lastHeartbeatAt: new Date(),
      disconnectedAt: null,
    }).onConflictDoUpdate({
      target: runnerInstances.runnerId,
      set: {
        bootId: input.bootId,
        poolId: input.poolId,
        runnerVersion: input.runnerVersion,
        nemoVersion: input.nemoVersion,
        maxConcurrency: input.maxConcurrency,
        compilerCapable: input.compilerCapable,
        labels: input.labels,
        desiredGeneration,
        appliedGeneration: input.appliedGeneration,
        heartbeatSequence: 0,
        status: input.appliedGeneration === desiredGeneration ? "ready" : "syncing",
        connectedAt: new Date(),
        lastHeartbeatAt: new Date(),
        disconnectedAt: null,
        updatedAt: new Date(),
      },
    });
    return desiredGeneration;
  }

  async recordHeartbeat(input: {
    runnerId: string; bootId: string; sequence: number; appliedGeneration: number; load: RunnerLoad;
  }): Promise<boolean> {
    const desiredGeneration = await this.desiredGeneration();
    const pressure = Math.max(
      input.load.maxConcurrency > 0 ? input.load.inflight / input.load.maxConcurrency : 0,
      input.load.cpuUtilization,
      input.load.memoryUtilization,
    );
    const status = input.appliedGeneration !== desiredGeneration
      ? "syncing"
      : input.load.queueDepth > 10 || pressure >= 0.9
        ? "saturated"
        : pressure >= 0.7
          ? "busy"
          : "ready";
    const updated = await this.db.update(runnerInstances).set({
      desiredGeneration,
      appliedGeneration: input.appliedGeneration,
      heartbeatSequence: input.sequence,
      load: input.load,
      status,
      lastHeartbeatAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(runnerInstances.runnerId, input.runnerId),
      eq(runnerInstances.bootId, input.bootId),
      lt(runnerInstances.heartbeatSequence, input.sequence),
    )).returning({ runnerId: runnerInstances.runnerId });
    return updated.length === 1;
  }

  async disconnectRunner(runnerId: string, bootId: string): Promise<void> {
    await this.db.update(runnerInstances).set({ status: "offline", disconnectedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(runnerInstances.runnerId, runnerId), eq(runnerInstances.bootId, bootId)));
  }

  async markStaleRunnersOffline(): Promise<void> {
    const cutoff = new Date(Date.now() - this.config.offlineAfterSeconds * 1_000);
    await this.db.update(runnerInstances).set({ status: "offline", disconnectedAt: new Date(), updatedAt: new Date() })
      .where(and(lte(runnerInstances.lastHeartbeatAt, cutoff), ne(runnerInstances.status, 'offline')));
  }

  async desiredStateForPool(poolId: string) {
    return this.db.transaction(async tx => {
    const [state] = await tx.select().from(controllerState).where(eq(controllerState.id, "singleton"));
    const generation = state?.desiredGeneration ?? 0;
    const activeArtifacts = poolId === "default"
      ? await tx.select({ artifact: artifacts }).from(guardrailVersions)
        .innerJoin(guardrails, and(eq(guardrails.id, guardrailVersions.guardrailId), isNull(guardrails.deletedAt)))
        .innerJoin(artifacts, eq(artifacts.id, guardrailVersions.artifactId))
        .where(eq(guardrailVersions.status, "ready"))
      : await tx.select({ artifact: artifacts }).from(routers)
        .innerJoin(guardrails, and(eq(guardrails.id, routers.guardrailId), eq(guardrails.status, "active")))
        .innerJoin(guardrailVersions, and(
          eq(guardrailVersions.guardrailId, routers.guardrailId),
          or(eq(guardrailVersions.version, routers.guardrailVersion), and(isNull(routers.guardrailVersion), eq(guardrailVersions.version, guardrails.activeVersion))),
          eq(guardrailVersions.status, "ready"),
        ))
        .innerJoin(artifacts, eq(artifacts.id, guardrailVersions.artifactId))
        .where(and(eq(routers.poolId, poolId), eq(routers.enabled, true), isNull(routers.deletedAt)));
    const disabledGuardrails = await tx.select({ id: guardrails.id }).from(guardrails).where(eq(guardrails.status, "disabled"));
    const loggingLevels = await tx.select({ id: guardrails.id, level: guardrails.loggingLevel })
      .from(guardrails).where(isNull(guardrails.deletedAt));
    const disabledEndpoints = await tx.select({ id: endpoints.id }).from(endpoints).where(eq(endpoints.status, "disabled"));
    const routes = await tx.select({
      routerId: routers.id,
      guardrailId: routers.guardrailId,
      artifactId: guardrailVersions.artifactId,
      endpointId: routers.endpointId,
      trafficScope: routers.trafficScope,
      routeOrder: routers.routeOrder,
    }).from(routers)
      .innerJoin(guardrails, and(eq(guardrails.id, routers.guardrailId), eq(guardrails.status, "active")))
      .innerJoin(guardrailVersions, and(
        eq(guardrailVersions.guardrailId, routers.guardrailId),
        or(eq(guardrailVersions.version, routers.guardrailVersion), and(isNull(routers.guardrailVersion), eq(guardrailVersions.version, guardrails.activeVersion))),
        eq(guardrailVersions.status, "ready"),
      ))
      .where(and(eq(routers.poolId, poolId), eq(routers.enabled, true), isNull(routers.deletedAt)))
      .orderBy(asc(routers.routeOrder), asc(routers.id));
    const endpointRows = await tx.select().from(endpoints).where(eq(endpoints.status, "active"));
    return {
      generation,
      artifacts: [...new Map(activeArtifacts.map((row) => [row.artifact.id, row.artifact])).values()],
      disabledGuardrailIds: disabledGuardrails.map((row) => row.id),
      disabledEndpointIds: disabledEndpoints.map((row) => row.id),
      routerRevisions: (await this.trafficRouting.runtimeSnapshots(tx)).map(router => ({ ...router, assignmentAlgorithm: "hmac-sha256-v1", assignmentKeyId: "v1", assignmentKey: createHash("sha256").update("traffic-router-assignment-v1:" + this.config.runnerToken).digest() })),
      routers: routes.filter((route) => route.artifactId !== null).map((route) => ({
        ...route,
        artifactId: route.artifactId as string,
        endpointId: route.endpointId,
      })),
      endpoints: endpointRows.map((endpoint) => ({
        endpointId: endpoint.id,
        trafficRouterId: endpoint.trafficRouterId,
        adapter: endpoint.adapter,
        verification: endpoint.verification,
      })),
      guardrailLoggingLevels: Object.fromEntries(loggingLevels.map((item) => [item.id, item.level])),
    };
    }, { isolationLevel: "repeatable read" });
  }

  async listRunnerPoolsWithCapacity() {
    const pools = await this.db.select().from(runnerPools).orderBy(desc(runnerPools.isDefault), runnerPools.name);
    const instances = await this.db.select().from(runnerInstances);
    return pools.map((pool) => {
      const poolRunners = instances.filter((runner) => runner.poolId === pool.id).map((runner) => ({
        status: runner.status,
        inflight: runner.load?.inflight ?? 0,
        maxConcurrency: runner.load?.maxConcurrency ?? runner.maxConcurrency,
        queueDepth: runner.load?.queueDepth ?? 0,
        cpuUtilization: runner.load?.cpuUtilization ?? 0,
        memoryUtilization: runner.load?.memoryUtilization ?? 0,
        requestsPerSecond: (runner.load?.requestsDelta ?? 0) / Math.max(
          0.001,
          (runner.load?.observationIntervalMs ?? this.config.heartbeatIntervalSeconds * 1_000) / 1_000,
        ),
        errorRate: ratio(
          (runner.load?.errorsDelta ?? 0) + (runner.load?.timeoutsDelta ?? 0),
          runner.load?.requestsDelta ?? 0,
        ),
        latencyP95Ms: runner.load?.latencyP95Ms ?? 0,
      }));
      return {
        ...pool,
        instances: instances.filter((runner) => runner.poolId === pool.id),
        capacity: calculatePoolCapacity(
          poolRunners,
          pool.safeRpsPerRunner,
          undefined,
          1.25,
          pool.isDefault ? 2 : 1,
        ),
      };
    });
  }

  async observabilitySnapshot() {
    const [watermarks, pendingOutbox, guardrailRows, routerRows, endpointRows] = await Promise.all([
      this.db.select().from(telemetryWatermarks),
      this.db.select({
        kind: outboxEvents.kind,
        pending: count(),
        oldestCreatedAt: min(outboxEvents.createdAt),
      }).from(outboxEvents)
        .where(isNull(outboxEvents.processedAt))
        .groupBy(outboxEvents.kind),
      this.db.select({
        id: guardrails.id,
        name: guardrails.name,
        status: guardrails.status,
        activeVersion: guardrails.activeVersion,
      }).from(guardrails).where(isNull(guardrails.deletedAt)),
      this.db.select({
        id: routers.id,
        name: routers.name,
        guardrailId: routers.guardrailId,
        guardrailVersion: routers.guardrailVersion,
        endpointId: routers.endpointId,
        poolId: routers.poolId,
        enabled: routers.enabled,
      }).from(routers).where(isNull(routers.deletedAt)),
      this.db.select({
        id: endpoints.id,
        name: endpoints.name,
        adapter: endpoints.adapter,
        status: endpoints.status,
        deletedAt: endpoints.deletedAt,
      }).from(endpoints),
    ]);
    const guardrailById = new Map(guardrailRows.map((item) => [item.id, item]));
    const endpointById = new Map(endpointRows.map((item) => [item.id, item]));
    const endpointBindings = new Map<string, {
      guardrailId: string;
      endpointId: string;
      endpointName: string;
      poolId: string;
      status: "active" | "inactive" | "disabled";
    }>();
    const routerTopology = routerRows.flatMap((item) => {
      const guardrail = guardrailById.get(item.guardrailId);
      if (!guardrail) return [];
      const endpoint = item.endpointId === null ? null : endpointById.get(item.endpointId);
      const guardrailVersion = item.guardrailVersion ?? guardrail.activeVersion;
      const status = !item.enabled
        ? "disabled"
        : guardrail.status !== "active"
          || guardrailVersion === null
          || (item.endpointId !== null && (!endpoint || endpoint.status !== "active" || endpoint.deletedAt !== null))
          ? "inactive"
          : "active";
      if (item.endpointId !== null && endpoint?.deletedAt === null) {
        const key = `${item.guardrailId}\u0000${item.endpointId}\u0000${item.poolId}`;
        const current = endpointBindings.get(key);
        const priority = { disabled: 0, inactive: 1, active: 2 } as const;
        if (!current || priority[status] > priority[current.status]) {
          endpointBindings.set(key, {
            guardrailId: item.guardrailId,
            endpointId: item.endpointId,
            endpointName: endpoint.name,
            poolId: item.poolId,
            status,
          });
        }
      }
      return [{
        guardrailId: item.guardrailId,
        guardrailVersion,
        routerId: item.id,
        routerName: item.name,
        poolId: item.poolId,
        status,
      }];
    });
    return {
      watermarks,
      pendingOutbox,
      guardrails: guardrailRows.map((item) => ({
        guardrailId: item.id,
        guardrailName: item.name,
        status: item.status,
        activeVersion: item.activeVersion,
      })),
      endpoints: endpointRows.filter((item) => item.deletedAt === null).map((item) => ({
        endpointId: item.id,
        endpointName: item.name,
        adapter: item.adapter,
        status: item.status,
      })),
      endpointBindings: [...endpointBindings.values()],
      routers: routerTopology,
    };
  }

  async updateRunnerPool(input: {
    id: string;
    desiredReplicas: number;
    safeRpsPerRunner: number;
    maxConcurrencyPerRunner: number;
    actorId: string;
  }) {
    if (input.id === "default" && input.desiredReplicas < 2) {
      throw new ValidationError("GuardRails 0 requires at least two desired replicas for rolling availability.", {
        minimumDesiredReplicas: 2,
      });
    }
    const [updated] = await this.db.transaction(async (tx) => {
      const rows = await tx.update(runnerPools).set({
        desiredReplicas: input.desiredReplicas,
        safeRpsPerRunner: input.safeRpsPerRunner,
        maxConcurrencyPerRunner: input.maxConcurrencyPerRunner,
        updatedAt: new Date(),
      }).where(eq(runnerPools.id, input.id)).returning();
      if (!rows[0]) throw new NotFoundError("Runner Pool", input.id);
      await tx.insert(auditEvents).values({
        id: randomUUID(),
        kind: "runner_pool.capacity_updated",
        actorId: input.actorId,
        resourceType: "runner_pool",
        resourceId: input.id,
        detail: {
          desiredReplicas: input.desiredReplicas,
          safeRpsPerRunner: input.safeRpsPerRunner,
          maxConcurrencyPerRunner: input.maxConcurrencyPerRunner,
        },
      });
      return rows;
    });
    return updated;
  }

  async removeRunnerInstance(input: { runnerId: string; actorId: string }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [removed] = await tx.delete(runnerInstances)
        .where(and(
          eq(runnerInstances.runnerId, input.runnerId),
          eq(runnerInstances.status, "offline"),
        ))
        .returning();

      if (!removed) {
        const [existing] = await tx.select({ status: runnerInstances.status })
          .from(runnerInstances)
          .where(eq(runnerInstances.runnerId, input.runnerId))
          .limit(1);
        if (!existing) throw new NotFoundError("Runner", input.runnerId);
        throw new ConflictError(
          "Only an offline Runner registration can be removed.",
          "runner_not_offline",
          { runnerId: input.runnerId, status: existing.status },
        );
      }

      await tx.insert(auditEvents).values({
        id: randomUUID(),
        kind: "runner_instance.removed",
        actorId: input.actorId,
        resourceType: "runner_instance",
        resourceId: removed.runnerId,
        detail: {
          bootId: removed.bootId,
          poolId: removed.poolId,
          lastHeartbeatAt: removed.lastHeartbeatAt.toISOString(),
          disconnectedAt: removed.disconnectedAt?.toISOString() ?? null,
        },
      });
    });
  }

  async pendingOutbox(kind: string, limit = 50) {
    return this.db.select().from(outboxEvents).where(and(
      eq(outboxEvents.kind, kind), isNull(outboxEvents.processedAt), lte(outboxEvents.availableAt, new Date()),
    )).orderBy(outboxEvents.createdAt).limit(limit);
  }

  async markOutboxProcessed(id: string): Promise<void> {
    await this.db.update(outboxEvents).set({ processedAt: new Date() }).where(eq(outboxEvents.id, id));
  }

  async deferOutbox(id: string, delaySeconds: number): Promise<void> {
    await this.db.update(outboxEvents).set({
      attempts: increment(outboxEvents.attempts),
      availableAt: new Date(Date.now() + delaySeconds * 1_000),
    }).where(eq(outboxEvents.id, id));
  }

  private async policyRecord(id: string) {
    const [record] = await this.db.select().from(policyRecords).where(eq(policyRecords.id, id));
    if (!record) throw new NotFoundError("Policy", id);
    return record;
  }

  private validatePolicyDraft(id: string, draft: ProgrammablePolicyDraft, validateDependencies: boolean): void {
    if (draft.colang_version !== "2.x") {
      throw new ValidationError("Custom Policies must use Colang 2.x on the programmable Runner lane.");
    }
    const sourcePaths = draft.sources.map((item) => item.path);
    if (new Set(sourcePaths).size !== sourcePaths.length) throw new ValidationError("Policy source paths must be unique.");
    const bindingKeys = draft.rail_bindings.map((item) => `${item.rail_type}:${item.flow_name}`);
    if (new Set(bindingKeys).size !== bindingKeys.length) throw new ValidationError("Policy Rail bindings must be unique.");
    const bindingNames = new Set(draft.rail_bindings.map((item) => item.flow_name));
    // Colang syntax, imports, Flow declarations and actual Action calls belong
    // to the Default Runner's NeMo parser. Regex scanning here treats comments
    // and literal text as code and diverges from the compiled execution path.
    // Drafts may be incomplete; publication still requires current Runner tests.
    for (const reference of draft.action_references) {
      if (!registeredAction(reference.name, reference.version)) {
        throw new ValidationError(`Policy ${id} references unregistered Action ${reference.name}@${reference.version}.`);
      }
    }
    for (const binding of draft.rail_bindings) {
      const missing = binding.depends_on.filter((item) => !bindingNames.has(item));
      if (missing.length) throw new ValidationError(`Flow ${binding.flow_name} depends on undefined Flows: ${missing.join(", ")}.`);
    }
    validateBindingGraph(draft);
    if (!validateDependencies) return;
    const rules = new Map(draft.rail_bindings.map((item) => [flowRuleId(item.rail_type, item.flow_name), item]));
    const covered = new Set<string>();
    const caseIds = draft.test_cases.map((item) => item.id).filter(Boolean);
    if (new Set(caseIds).size !== caseIds.length) throw new ValidationError("Policy Test Case IDs must be unique.");
    for (const test of draft.test_cases) {
      for (const ruleId of test.covered_rule_ids) {
        const rule = rules.get(ruleId);
        if (!rule) throw new ValidationError(`Policy Test Case ${test.name} references unknown Rule ${ruleId}.`);
        if (rule.rail_type !== test.rail_type) throw new ValidationError(`Policy Test Case ${test.name} must run on the same Rail as ${ruleId}.`);
        if (test.required) covered.add(ruleId);
      }
    }
    const uncovered = [...rules.keys()].filter((item) => !covered.has(item));
    if (uncovered.length) throw new ValidationError(`Every Policy Rule requires a reviewed Test Case; missing ${uncovered.join(", ")}.`);
  }

  private policyCatalog(): PolicyCatalog {
    this.catalog ??= PolicyCatalog.load(this.config.policyCatalogDir);
    return this.catalog;
  }

  private async ensureDefaultGuardrail(
    tx: Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0],
  ): Promise<void> {
    const desiredDraft = defaultGuardrailDraft(this.policyCatalog().list());
    let [stored] = await tx.select().from(guardrails)
      .where(eq(guardrails.id, DEFAULT_GUARDRAIL_ID)).for("update");
    let restored = false;
    let baselineChanged = false;
    if (!stored) {
      [stored] = await tx.insert(guardrails).values({
        id: DEFAULT_GUARDRAIL_ID,
        name: DEFAULT_GUARDRAIL_NAME,
        draftConfig: desiredDraft,
        runtimeProfile: "auto",
      }).returning();
      if (!stored) throw new Error("Default Guardrail creation did not return the stored resource.");
      await this.syncGeneratedTestCases(tx, DEFAULT_GUARDRAIL_ID, desiredDraft);
      await tx.insert(auditEvents).values({
        id: randomUUID(),
        kind: "guardrail.default.created",
        actorId: null,
        resourceType: "guardrail",
        resourceId: DEFAULT_GUARDRAIL_ID,
        detail: { localOnly: true, phases: ["input", "output"], policies: desiredDraft.policyBindings.map((item) => item.policyId) },
      });
    } else if (stored.deletedAt || stored.status === "disabled") {
      const [enabled] = await tx.update(guardrails).set({
        status: stored.activeArtifactId ? "active" : "draft",
        deletedAt: null,
        deletedBy: null,
        deleteReason: null,
        updatedAt: new Date(),
      }).where(eq(guardrails.id, DEFAULT_GUARDRAIL_ID)).returning();
      if (!enabled) throw new Error("Default Guardrail restoration did not return the stored resource.");
      stored = enabled;
      restored = true;
      await tx.insert(auditEvents).values({
        id: randomUUID(),
        kind: "guardrail.default.restored",
        actorId: null,
        resourceType: "guardrail",
        resourceId: DEFAULT_GUARDRAIL_ID,
        detail: { reason: "required_product_baseline" },
      });
    }

    const [userCustomization] = await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
      eq(auditEvents.resourceType, "guardrail"),
      eq(auditEvents.resourceId, DEFAULT_GUARDRAIL_ID),
      isNotNull(auditEvents.actorId),
    )).limit(1);
    if (!userCustomization && stableJson(normalizeGuardrailDraft(stored.draftConfig)) !== stableJson(normalizeGuardrailDraft(desiredDraft))) {
      const nextExcluded = await this.syncGeneratedTestCases(
        tx,
        DEFAULT_GUARDRAIL_ID,
        desiredDraft,
        stored.excludedTestCaseIds,
      );
      const [upgraded] = await tx.update(guardrails).set({
        draftConfig: desiredDraft,
        draftRevision: increment(guardrails.draftRevision),
        excludedTestCaseIds: nextExcluded,
        updatedAt: new Date(),
      }).where(eq(guardrails.id, DEFAULT_GUARDRAIL_ID)).returning();
      if (!upgraded) throw new Error("Default Guardrail baseline upgrade did not return the stored resource.");
      stored = upgraded;
      baselineChanged = true;
      await tx.insert(auditEvents).values({
        id: randomUUID(),
        kind: "guardrail.default.baseline_upgraded",
        actorId: null,
        resourceType: "guardrail",
        resourceId: DEFAULT_GUARDRAIL_ID,
        detail: { draftRevision: stored.draftRevision, policies: desiredDraft.policyBindings.map((item) => item.policyId) },
      });
    }

    const [activeVersion] = stored.activeVersion ? await tx.select({ sourceDraftRevision: guardrailVersions.sourceDraftRevision })
      .from(guardrailVersions).where(and(eq(guardrailVersions.guardrailId, DEFAULT_GUARDRAIL_ID), eq(guardrailVersions.version, stored.activeVersion))) : [];
    if (stored.activeArtifactId && stored.activeVersion && !baselineChanged
      && (userCustomization || activeVersion?.sourceDraftRevision === stored.draftRevision)) {
      const routerChanged = await this.ensureDefaultRouter(tx, stored.activeVersion);
      if (restored || routerChanged) {
        const [state] = await tx.update(controllerState)
          .set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
          .where(eq(controllerState.id, "singleton")).returning();
        if (!state) throw new Error("Controller state is not initialized.");
        await tx.update(guardrails).set({ desiredGeneration: state.desiredGeneration })
          .where(eq(guardrails.id, DEFAULT_GUARDRAIL_ID));
        await tx.insert(outboxEvents).values({
          id: randomUUID(),
          kind: "runner.desired_state_changed",
          aggregateId: DEFAULT_GUARDRAIL_ID,
          payload: { guardrailId: DEFAULT_GUARDRAIL_ID, generation: state.desiredGeneration, baselineRestored: true },
        });
      }
      return;
    }

    // User-authored Default changes use the ordinary explicit Validate/Publish
    // workflow. Only the unmodified product baseline is bootstrapped for them.
    if (userCustomization) return;
    const [validation] = await tx.select().from(validationRuns).where(and(
      eq(validationRuns.guardrailId, DEFAULT_GUARDRAIL_ID),
      eq(validationRuns.sourceDraftRevision, stored.draftRevision),
    )).orderBy(desc(validationRuns.createdAt)).limit(1);
    if (!validation) {
      await this.enqueueGuardrailValidation(tx, stored, null);
      return;
    }
    // Pending/failed validation is visible in the normal UI. Do not loop on
    // failures at every restart or silently compile around them.
    if (validation.status !== "passed") return;
    const version = guardrailVersionId(validation.createdAt);
    const [existingVersion] = await tx.select({ version: guardrailVersions.version }).from(guardrailVersions).where(and(
      eq(guardrailVersions.guardrailId, DEFAULT_GUARDRAIL_ID),
      eq(guardrailVersions.version, version),
    )).limit(1);
    if (existingVersion) return;

    const [state] = await tx.update(controllerState)
      .set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
      .where(eq(controllerState.id, "singleton")).returning();
    if (!state) throw new Error("Controller state is not initialized.");
    const plan = buildGuardrailPlan({
      guardrailId: DEFAULT_GUARDRAIL_ID,
      guardrailVersion: version,
      draft: normalizeGuardrailDraft(stored.draftConfig),
      policies: this.policyCatalog().list(),
    });
    await this.assertValidatedPlan(tx, validation.id, plan, stored.runtimeProfile);
    const compileId = randomUUID();
    await tx.insert(guardrailVersions).values({
      guardrailId: DEFAULT_GUARDRAIL_ID,
      version,
      generation: state.desiredGeneration,
      sourceDraftRevision: stored.draftRevision,
      sourceSnapshot: { draftConfig: stored.draftConfig, runtimeProfile: stored.runtimeProfile, loggingLevel: stored.loggingLevel, excludedTestCaseIds: stored.excludedTestCaseIds, testCases: await tx.select().from(testCases).where(eq(testCases.guardrailId, DEFAULT_GUARDRAIL_ID)) },
      status: "compiling",
      runtimeProfile: stored.runtimeProfile,
      plan,
      createdBy: null,
    });
    await tx.update(guardrails).set({
      status: stored.activeArtifactId ? "active" : "draft",
      desiredGeneration: state.desiredGeneration,
      updatedAt: new Date(),
    }).where(eq(guardrails.id, DEFAULT_GUARDRAIL_ID));
    await tx.insert(outboxEvents).values({
      id: compileId,
      kind: "guardrail.compile_requested",
      aggregateId: DEFAULT_GUARDRAIL_ID,
      payload: {
        compileId,
        guardrailId: DEFAULT_GUARDRAIL_ID,
        guardrailVersion: version,
        generation: state.desiredGeneration,
        plan,
        runtimeProfile: stored.runtimeProfile,
      },
    });
    await tx.insert(auditEvents).values({
      id: randomUUID(),
      kind: "guardrail.default.compile_requested",
      actorId: null,
      resourceType: "guardrail",
      resourceId: DEFAULT_GUARDRAIL_ID,
      detail: { version, generation: state.desiredGeneration, sourceDraftRevision: stored.draftRevision, validationRunId: validation.id },
    });
  }

  private async ensureDefaultRouter(
    tx: Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0],
    guardrailVersion: string,
  ): Promise<boolean> {
    const [existing] = await tx.select().from(routers)
      .where(eq(routers.id, DEFAULT_ROUTER_ID)).for("update");
    if (!existing) {
      await tx.insert(routers).values({
        id: DEFAULT_ROUTER_ID,
        name: DEFAULT_ROUTER_NAME,
        guardrailId: DEFAULT_GUARDRAIL_ID,
        guardrailVersion,
        endpointId: null,
        poolId: "default",
        routeOrder: 100,
        enabled: true,
        trafficScope: { combinator: "and", conditions: [] },
      });
      await tx.insert(auditEvents).values({
        id: randomUUID(),
        kind: "router.default.created",
        actorId: null,
        resourceType: "router",
        resourceId: DEFAULT_ROUTER_ID,
        detail: { guardrailId: DEFAULT_GUARDRAIL_ID, guardrailVersion, poolId: "default" },
      });
      return true;
    }
    const changed = (
      existing.guardrailId !== DEFAULT_GUARDRAIL_ID
      || existing.guardrailVersion !== guardrailVersion
      || existing.endpointId !== null
      || existing.poolId !== "default"
      || existing.routeOrder !== 100
      || !existing.enabled
      || !isCatchAllTrafficScope(existing.trafficScope)
    );
    if (!changed) return false;
    await tx.update(routers).set({
      name: DEFAULT_ROUTER_NAME,
      guardrailId: DEFAULT_GUARDRAIL_ID,
      guardrailVersion,
      endpointId: null,
      poolId: "default",
      routeOrder: 100,
      enabled: true,
      trafficScope: { combinator: "and", conditions: [] },
      updatedAt: new Date(),
    }).where(eq(routers.id, DEFAULT_ROUTER_ID));
    await tx.insert(auditEvents).values({
      id: randomUUID(),
      kind: "router.default.restored",
      actorId: null,
      resourceType: "router",
      resourceId: DEFAULT_ROUTER_ID,
      detail: { guardrailId: DEFAULT_GUARDRAIL_ID, guardrailVersion, poolId: "default" },
    });
    return true;
  }

  private async validateGuardrailDraft(draft: GuardrailDraftConfig): Promise<ProgrammablePolicySnapshot[]> {
    try {
      const programmablePolicies = await this.resolveProgrammablePolicies(draft);
      buildGuardrailPlan({
        guardrailId: "guardrail-draft-validation",
        guardrailVersion: guardrailVersionId(),
        draft,
        policies: this.policyCatalog().list(),
        programmablePolicies,
      });
      return programmablePolicies;
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : "Guardrail draft is invalid.");
    }
  }

  private async resolveProgrammablePolicies(draft: GuardrailDraftConfig): Promise<ProgrammablePolicySnapshot[]> {
    const customBindings = draft.policyBindings.filter((binding) => !this.policyCatalog().get(binding.policyId));
    if (!customBindings.length) return [];
    const ids = [...new Set(customBindings.map((item) => item.policyId))];
    const rows = await this.db.select().from(policyVersions).where(inArray(policyVersions.policyId, ids));
    const byKey = new Map(rows.map((item) => [`${item.policyId}@${item.version}`, item.snapshot]));
    return customBindings.map((binding) => {
      if (!/^\d+$/.test(binding.policyVersion)) {
        throw new ValidationError(`Custom Policy ${binding.policyId} requires a numeric published version.`);
      }
      const snapshot = byKey.get(`${binding.policyId}@${Number(binding.policyVersion)}`);
      if (!snapshot) throw new ValidationError(`Policy ${binding.policyId}@${binding.policyVersion} is not published in Controller.`);
      return snapshot;
    });
  }

  private async guardrailSummary(row: typeof guardrails.$inferSelect) {
    const [latestValidation] = await this.db.select().from(validationRuns)
      .where(eq(validationRuns.guardrailId, row.id)).orderBy(desc(validationRuns.createdAt)).limit(1);
    const [caseCount] = await this.db.select({ value: count() }).from(testCases)
      .where(eq(testCases.guardrailId, row.id));
    const [activeVersion] = row.activeVersion === null ? [] : await this.db.select({ sourceDraftRevision: guardrailVersions.sourceDraftRevision })
      .from(guardrailVersions).where(and(
        eq(guardrailVersions.guardrailId, row.id), eq(guardrailVersions.version, row.activeVersion),
      ));
    const { duplicateKey: _duplicateKey, copyOrigin, ...publicRow } = row;
    const { requestDigest: _requestDigest, ...publicOrigin } = copyOrigin ?? {};
    return {
      ...publicRow,
      copyOrigin: copyOrigin ? publicOrigin : null,
      draftConfig: normalizeGuardrailDraft(row.draftConfig),
      latestValidationRun: latestValidation ?? null,
      testCaseCount: caseCount?.value ?? 0,
      excludedTestCaseCount: row.excludedTestCaseIds.length,
      activeSourceDraftRevision: activeVersion?.sourceDraftRevision ?? null,
    };
  }

  private async syncGeneratedTestCases(
    tx: Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0],
    guardrailId: string,
    draft: GuardrailDraftConfig,
    priorExcluded: readonly string[] = [],
  ): Promise<string[]> {
    const programmablePolicies = await this.resolveProgrammablePolicies(draft);
    const generated = generatedTestCases(guardrailId, draft, this.policyCatalog().list(), programmablePolicies);
    try {
      applyValidationOverrides(generated, draft);
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : "Invalid Validation expectation override.");
    }
    await tx.delete(testCases).where(and(eq(testCases.guardrailId, guardrailId), eq(testCases.origin, "generated")));
    if (generated.length) await tx.insert(testCases).values(generated);
    const generatedIds = new Set(generated.map((item) => item.id));
    return priorExcluded.filter((id) => generatedIds.has(id));
  }

  private publicEndpoint(endpoint: typeof endpoints.$inferSelect) {
    return {
      id: endpoint.id,
      trafficRouterId: endpoint.trafficRouterId,
      name: endpoint.name,
      adapter: endpoint.adapter,
      status: endpoint.status,
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
      credentials: publicEndpointCredentials(endpoint.verification),
      setup: endpointSetup(this.config.runtimeServiceUrl, endpoint.id, endpoint.adapter),
    };
  }

  private async advanceEndpointDesiredState(
    tx: Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0],
    input: {
      endpointId: string;
      actorId: string;
      auditKind: string;
      auditDetail: Record<string, unknown>;
    },
  ): Promise<number> {
    const [state] = await tx.update(controllerState)
      .set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
      .where(eq(controllerState.id, "singleton")).returning();
    if (!state) throw new Error("Controller state is not initialized.");
    await tx.insert(auditEvents).values({
      id: randomUUID(),
      kind: input.auditKind,
      actorId: input.actorId,
      resourceType: "endpoint",
      resourceId: input.endpointId,
      detail: { ...input.auditDetail, generation: state.desiredGeneration },
    });
    await tx.insert(outboxEvents).values({
      id: randomUUID(),
      kind: "runner.desired_state_changed",
      aggregateId: input.endpointId,
      payload: {
        resourceType: "endpoint",
        resourceId: input.endpointId,
        generation: state.desiredGeneration,
        change: input.auditKind,
      },
    });
    return state.desiredGeneration;
  }

  private async mutateRouter(
    id: string,
    actorId: string,
    auditKind: string,
    mutation: (
      tx: Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0],
      current: typeof routers.$inferSelect,
    ) => Promise<typeof routers.$inferSelect>,
  ) {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(routers)
        .where(and(eq(routers.id, id), isNull(routers.deletedAt))).for("update");
      if (!current) throw new NotFoundError("Router", id);
      if (current.id === DEFAULT_ROUTER_ID) {
        throw new ValidationError("The Default Router is system managed and cannot be changed directly.");
      }
      const updated = await mutation(tx, current);
      await this.advanceRouterDesiredState(tx, id, actorId, auditKind, {
        endpointId: current.endpointId,
        guardrailId: current.guardrailId,
      });
      return updated;
    });
  }

  private async advanceRouterDesiredState(
    tx: Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0],
    aggregateId: string,
    actorId: string,
    auditKind: string,
    detail: Record<string, unknown>,
  ): Promise<number> {
    const [state] = await tx.update(controllerState)
      .set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
      .where(eq(controllerState.id, "singleton")).returning();
    if (!state) throw new Error("Controller state is not initialized.");
    await tx.insert(auditEvents).values({
      id: randomUUID(), kind: auditKind, actorId,
      resourceType: "router", resourceId: aggregateId,
      detail: { ...detail, generation: state.desiredGeneration },
    });
    await tx.insert(outboxEvents).values({
      id: randomUUID(), kind: "runner.desired_state_changed", aggregateId,
      payload: { resourceType: "router", resourceId: aggregateId, generation: state.desiredGeneration, change: auditKind },
    });
    return state.desiredGeneration;
  }

  private async deletionImpact(kind: "guardrail" | "endpoint" | "router", id: string, routerPoolIds: readonly string[]): Promise<DeletionImpact> {
    const cutoff = new Date(Date.now() - this.config.deletionTrafficWindowMinutes * 60_000);
    const condition = kind === "guardrail"
      ? eq(runtimeEvents.guardrailId, id)
      : kind === "endpoint"
        ? eq(runtimeEvents.endpointId, id)
        : eq(runtimeEvents.routerId, id);
    const [traffic] = await this.db.select({ requestCount: count(), lastRequestAt: max(runtimeEvents.occurredAt) })
      .from(runtimeEvents).where(and(condition, eq(runtimeEvents.direction, "incoming"), gte(runtimeEvents.occurredAt, cutoff)));
    const activeRouterCount = routerPoolIds.length;
    const uniquePoolIds = [...new Set(routerPoolIds)];
    const runnerTelemetry = uniquePoolIds.length === 0 ? [] : await this.db.select({
      status: runnerInstances.status,
      lastHeartbeatAt: runnerInstances.lastHeartbeatAt,
      lastReceivedAt: telemetryWatermarks.lastReceivedAt,
    }).from(runnerInstances)
      .leftJoin(telemetryWatermarks, eq(telemetryWatermarks.runnerId, runnerInstances.runnerId))
      .where(inArray(runnerInstances.poolId, uniquePoolIds));
    const heartbeatCutoff = Date.now() - this.config.offlineAfterSeconds * 1_000;
    const servingRunners = runnerTelemetry.filter((runner) => (
      runner.status !== "offline" && runner.lastHeartbeatAt.getTime() >= heartbeatCutoff
    ));
    const telemetryCutoff = Date.now() - this.config.telemetryStaleAfterSeconds * 1_000;
    const telemetryFresh = activeRouterCount === 0 || (
      servingRunners.length > 0
      && servingRunners.every((runner) => Boolean(runner.lastReceivedAt && runner.lastReceivedAt.getTime() >= telemetryCutoff))
    );
    const telemetryWatermark = servingRunners.some((runner) => !runner.lastReceivedAt)
      ? null
      : servingRunners.reduce<Date | null>((oldest, runner) => (
          !oldest || (runner.lastReceivedAt && runner.lastReceivedAt < oldest)
            ? runner.lastReceivedAt
            : oldest
        ), null);
    const incomingRequestCount = traffic?.requestCount ?? 0;
    return {
      resourceId: id,
      windowMinutes: this.config.deletionTrafficWindowMinutes,
      incomingRequestCount,
      lastRequestAt: traffic?.lastRequestAt ?? null,
      activeRouterCount,
      telemetryFresh,
      telemetryWatermark,
      requiresSecondConfirmation: incomingRequestCount > 0,
    };
  }

  private assertDeletionAllowed(
    impact: DeletionImpact,
    confirmed: boolean,
    confirmationName: string | undefined,
    resourceName: string,
  ): void {
    if (!impact.telemetryFresh) {
      throw new ConflictError(
        "Runtime telemetry is stale, so recent traffic cannot be evaluated safely.",
        "telemetry_stale",
        { impact },
      );
    }
    if (impact.requiresSecondConfirmation && !confirmed) {
      throw new ConflictError(
        "Recent incoming traffic requires explicit second confirmation.",
        "recent_traffic_confirmation_required",
        { impact },
      );
    }
    if (impact.requiresSecondConfirmation && confirmationName !== resourceName) {
      throw new ConflictError(
        "The second confirmation must contain the exact resource name.",
        "confirmation_name_mismatch",
        { impact },
      );
    }
  }

  private async recordSoftDelete(
    tx: Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0],
    resourceType: "guardrail" | "endpoint",
    input: { id: string; actorId: string; reason: string },
    impact: DeletionImpact,
    generation: number,
  ) {
    await tx.insert(auditEvents).values({
      id: randomUUID(), kind: `${resourceType}.disabled`, actorId: input.actorId,
      resourceType, resourceId: input.id,
      detail: { reason: input.reason, impact, generation },
    });
    await tx.insert(outboxEvents).values({
      id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: input.id,
      payload: { resourceType, resourceId: input.id, generation, disabled: true },
    });
  }
}

export function isCatchAllTrafficScope(scope: unknown): boolean {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return false;
  const conditions = (scope as { conditions?: unknown }).conditions;
  return Array.isArray(conditions) && conditions.length === 0;
}

export function assertCatchAllTopology(
  routes: Array<{ routeOrder: number; trafficScope: unknown }>,
): void {
  const ordered = [...routes].sort((left, right) => left.routeOrder - right.routeOrder);
  const catchAllIndexes = ordered.flatMap((route, index) => (
    isCatchAllTrafficScope(route.trafficScope) ? [index] : []
  ));
  if (catchAllIndexes.length > 1) {
    throw new ConflictError(
      "An Endpoint can have only one catch-all Router.",
      "router_catch_all_conflict",
    );
  }
  if (catchAllIndexes.length === 1 && catchAllIndexes[0] !== ordered.length - 1) {
    throw new ConflictError(
      "The catch-all Router must be the final route for its Endpoint.",
      "router_catch_all_order_conflict",
    );
  }
}

export function programmablePolicyPayload(
  record: typeof policyRecords.$inferSelect,
  versions: Array<typeof policyVersions.$inferSelect>,
) {
  return {
    ...programmablePolicySurface(record, versions),
    // Immutable selectable metadata for older pinned bindings. Do not duplicate
    // source files or recursively embed editor state in these version surfaces.
    published_versions: versions.map((version) => {
      const { implementation_detail: _detail, draft_revision: _draft, ...surface } = programmablePolicySurface(record, [version]);
      return surface;
    }),
  };
}

function programmablePolicySurface(
  record: typeof policyRecords.$inferSelect,
  versions: Array<typeof policyVersions.$inferSelect>,
) {
  // The selectable surface must describe the same immutable version that a
  // Guardrail will bind. Keep the editable draft only in implementation_detail.
  // Sorting a copy avoids depending on database/result order or mutating callers.
  const latest = [...versions].sort((left, right) => right.version - left.version)[0];
  const surface = latest?.snapshot ?? record.draft;
  const rules = surface.rail_bindings.map((binding) => ({
    id: flowRuleId(binding.rail_type, binding.flow_name),
    name: binding.flow_name.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (value) => value.toUpperCase()),
    description: `Runs ${binding.flow_name} on the ${binding.rail_type} Rail and applies ${binding.on_unsafe} when the Flow reports unsafe content.`,
    form: "colang_flow" as const,
    effect: binding.on_unsafe,
    rails: [binding.rail_type],
    implementation: {
      engine: "nemo-guardrails",
      form: "colang_flow" as const,
      binding_id: record.id,
      implementation_rule_id: binding.flow_name,
      detector: null,
      flow_name: binding.flow_name,
      action_name: null,
    },
    expression: null,
    context_expression: null,
    redaction: null,
    severity_threshold: null,
    identifiers: [], conditions: [], keywords: [], always_block: [], exceptions: [], phrase_patterns: [],
  }));
  const railTypes = [...new Set(surface.rail_bindings.map((item) => item.rail_type))].sort();
  const effects = [...new Set(surface.rail_bindings.map((item) => item.on_unsafe))].sort();
  const testCases = surface.test_cases.map((item, index) => ({
    id: item.id || `draft/${index + 1}`,
    name: item.name,
    description: item.description || `Validates the published behavior for ${item.rail_type} traffic.`,
    phase: item.rail_type,
    content: item.content,
    expected_decision: item.expected_decision,
    covered_rule_ids: item.covered_rule_ids,
    group: "Policy validation",
    kind: item.required ? "rule_acceptance" as const : "scenario" as const,
    required: item.required,
    parameter_names: [],
    case_type: item.case_type,
    expected_failure: item.expected_failure,
    concurrency_group: item.concurrency_group,
    trusted_instruction: item.trusted_instruction,
    use_guardrail_instruction: item.use_guardrail_instruction,
    for_each: item.for_each,
    target_source: item.target_source,
    query: item.query,
    grounding_sources: item.grounding_sources,
    expected_reasoning_result: item.expected_reasoning_result,
  }));
  const outputDelivery = Object.fromEntries(surface.execution_contract).output_delivery;
  return {
    implementation: "nemo_native" as const,
    id: record.id,
    name: latest?.snapshot.name ?? record.name,
    description: latest?.snapshot.description ?? record.description,
    source: "custom" as const,
    version: String(latest?.version ?? 0),
    draft_revision: record.draftRevision,
    owner: latest?.snapshot.owner ?? record.owner,
    updated_at: (latest?.publishedAt ?? record.updatedAt).toISOString(),
    tags: [
      {
        id: `guardrail_category:${surface.guardrail_category}`,
        namespace: "guardrail_category" as const,
        value: surface.guardrail_category,
        label: guardrailCategoryLabels[surface.guardrail_category],
        source: "declared" as const,
      },
      { id: `implementation:colang-${surface.colang_version}`, namespace: "implementation", value: `colang-${surface.colang_version}`, label: `Colang ${surface.colang_version}`, source: "derived" as const },
      ...railTypes.map((railType) => ({
        id: `rail:${railType}`,
        namespace: "rail" as const,
        value: railType,
        label: `${railType[0]!.toUpperCase()}${railType.slice(1)} rail`,
        source: "derived" as const,
      })),
    ],
    parameters: surface.parameter_schema,
    rails: railTypes,
    effects,
    forms: ["colang_flow" as const],
    rules,
    test_cases: testCases,
    test_count: testCases.length,
    safety_level: "balanced" as const,
    protection: programmablePolicyProtection(surface),
    output_delivery: outputDelivery === "interruptible" || outputDelivery === "full_buffered" ? outputDelivery : "window_buffered" as const,
    implementation_detail: {
      implementation: "nemo_native" as const,
      id: record.id,
      name: record.name,
      description: record.description,
      source: "custom" as const,
      owner: record.owner,
      draft: record.draft,
      draft_revision: record.draftRevision,
      updated_at: record.updatedAt.toISOString(),
      versions: versions.map((item) => item.snapshot),
    },
  };
}

function policySnapshot(
  record: typeof policyRecords.$inferSelect,
  version: string,
  checksum: string,
  publishedAt = new Date(),
): ProgrammablePolicySnapshot {
  return {
    policy_id: record.id,
    version,
    name: record.name,
    description: record.description,
    source: "custom",
    owner: record.owner,
    ...record.draft,
    checksum,
    published_at: publishedAt.toISOString(),
  };
}

function programmablePolicyPlan(
  policyId: string,
  policyName: string,
  version: string,
  snapshot: ProgrammablePolicySnapshot,
): Record<string, unknown> {
  const contract = Object.fromEntries(snapshot.execution_contract);
  const nativeRisk = contract.native_risk;
  const phases = [...new Set(snapshot.rail_bindings.map((item) => item.rail_type))];
  const action = snapshot.rail_bindings[0]?.on_unsafe ?? "reject";
  const steps = nativeRisk ? [{
    id: `${nativeRisk}:primary`,
    capability: nativeRisk,
    contract_ref: snapshot.evaluation_contracts[0] ?? `tali.guard.${nativeRisk.replaceAll("_", "-")}.v1`,
    phases,
    on_unsafe: action,
    trigger: { type: "always" },
    parameters: [],
  }] : [];
  const modules = steps.length ? phases.map((phase) => ({
    id: `business_assurance:${phase}`,
    module: "business_assurance",
    phase,
    step_ids: steps.map((item) => item.id),
    depends_on: [],
    input_view: "original",
    required_for_release: true,
    timeout_ms: 5_000,
    failure_mode: "fail_closed",
  })) : [];
  return {
    guardrail_id: `policy-preview-${policyId}`,
    guardrail_version: version,
    compiler_version: "tasklattice-controller-plan-v3",
    safety_level: "balanced",
    output_delivery: contract.output_delivery ?? "window_buffered",
    steps,
    modules,
    reasoning_policies: [],
    policy_versions: [{
      policy_id: snapshot.policy_id,
      version: snapshot.version,
      name: snapshot.name,
      source: snapshot.source,
      colang_version: snapshot.colang_version,
      sources: snapshot.sources,
      parameter_schema: snapshot.parameter_schema.map((item) => [item.name, item.kind]),
      rail_bindings: snapshot.rail_bindings,
      action_references: snapshot.action_references,
      evaluation_contracts: snapshot.evaluation_contracts,
      prompt_dependencies: snapshot.prompt_dependencies,
      execution_contract: snapshot.execution_contract,
      test_cases: snapshot.test_cases.map((item) => [item.name, item.expected_decision]),
      checksum: snapshot.checksum,
    }],
    policy_bindings: [{
      policy_id: snapshot.policy_id,
      policy_version: snapshot.version,
      action: null,
      parameter_values: snapshot.parameter_schema.flatMap((item) => item.default === null ? [] : [[item.name, item.default]]),
      enabled_rule_ids: snapshot.rail_bindings.map((item) => flowRuleId(item.rail_type, item.flow_name)),
      rule_actions: [],
      enabled_rails: phases,
    }],
  };
}

function policyTestCasePayload(
  policyId: string,
  version: string,
  item: ProgrammablePolicyDraft["test_cases"][number],
  index: number,
) {
  return {
    id: item.id || `policy-${policyId}-case-${index + 1}`,
    name: item.name,
    policyId,
    phase: item.rail_type,
    content: item.content,
    expectedDecision: item.expected_decision,
    trustedInstruction: item.trusted_instruction,
    targetSource: item.target_source,
    query: item.query,
    groundingSources: item.grounding_sources,
    expectedReasoningResult: item.expected_reasoning_result,
    caseType: item.case_type,
    required: item.required,
    expectedFailure: item.expected_failure,
    concurrencyGroup: item.concurrency_group,
    sourcePolicyId: policyId,
    sourcePolicyVersion: version,
    sourceCaseId: item.id || null,
    coveredRuleIds: item.covered_rule_ids,
  };
}

function policyValidationResult(item: ValidationCaseResult): PolicyValidationResult {
  return {
    name: item.name,
    case_type: item.caseType,
    required: item.required,
    rail_type: item.phase,
    concurrency_group: item.concurrencyGroup,
    expected_decision: item.expectedDecision,
    expected_failure: item.expectedFailure,
    actual_decision: item.actualDecision,
    actual_failure: item.actualFailure,
    passed: item.passed,
    latency_ms: item.latencyMs,
    reason: item.reason,
    covered_rule_ids: item.coveredRuleIds,
    matched_rule_ids: item.matchedRuleIds,
    trace: item.trace,
  };
}

function policyValidationPayload(item: typeof policyValidationRuns.$inferSelect) {
  return {
    id: item.id,
    policy_id: item.policyId,
    draft_revision: item.draftRevision,
    status: item.status,
    results: item.results,
    created_at: item.createdAt.toISOString(),
    failure_reason: item.failureReason,
  };
}

function validateBindingGraph(draft: ProgrammablePolicyDraft): void {
  const graph = new Map(draft.rail_bindings.map((item) => [item.flow_name, item.depends_on]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (flow: string) => {
    if (visiting.has(flow)) throw new ValidationError(`Policy Rail dependency graph contains a cycle at ${flow}.`);
    if (visited.has(flow)) return;
    visiting.add(flow);
    for (const dependency of graph.get(flow) ?? []) visit(dependency);
    visiting.delete(flow);
    visited.add(flow);
  };
  for (const flow of graph.keys()) visit(flow);
  const positions = new Map(draft.rail_bindings.map((binding, index) => [binding.flow_name, index]));
  for (const binding of draft.rail_bindings) {
    for (const dependency of binding.depends_on) {
      const source = draft.rail_bindings[positions.get(dependency)!];
      if (!source || source.rail_type !== binding.rail_type || positions.get(dependency)! >= positions.get(binding.flow_name)!) {
        throw new ValidationError(`Flow ${binding.flow_name} must follow dependency ${dependency} in the same Rail's list order.`);
      }
    }
  }
}

function decryptRuntimeEventMetadata(value: Record<string, unknown>, key: Buffer | null): Record<string, unknown> {
  const decrypted = decryptRuntimeLogPayload(value.contentCiphertext, key);
  if (!decrypted) return value;
  const { contentCiphertext: _ciphertext, ...metadata } = value;
  return {
    ...metadata,
    contentBefore: decrypted.contentBefore ?? null,
    contentAfter: decrypted.contentAfter ?? null,
    contentAvailable: true,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export function endpointSetup(runtimeServiceUrl: string, endpointId: string, adapter: string) {
  const apiBaseUrl = `${runtimeServiceUrl}/runtime/v1/endpoints/${encodeURIComponent(endpointId)}`;
  const isLiteLLM = adapter === "litellm-generic-guardrail";
  const callbackUrl = isLiteLLM
    ? `${apiBaseUrl}/beta/litellm_basic_guardrail_api`
    : `${apiBaseUrl}/guardrails/evaluate`;
  const recommendedModes = isLiteLLM
    ? ["pre_call", "post_call"]
    : ["input", "output"];
  const yamlTemplate = isLiteLLM
    ? [
        "# Requires the TaskLattice Guard endpoint supplied by Relay.",
        "credential_list:",
        "  - credential_name: tasklattice-guard",
        "    credential_info:",
        "      custom_llm_provider: tasklattice_guard",
        "    credential_values:",
        "      api_key: os.environ/TASKLATTICE_GUARD_API_KEY",
        "guardrails:",
        "  - guardrail_name: tasklattice-guard",
        "    litellm_params:",
        "      guardrail: tasklattice_guard",
        "      mode: [pre_call, post_call]",
        "      api_base: os.environ/TASKLATTICE_GUARD_API_BASE",
        "      credential_name: tasklattice-guard",
        "      default_on: true",
        "      fail_on_error: true",
        "      unreachable_fallback: fail_closed",
        "",
      ].join("\n")
    : [
        "tasklattice_guard:",
        `  callback_url: "${callbackUrl}"`,
        "  api_key: os.environ/TASKLATTICE_GUARD_API_KEY",
        `  modes: [${recommendedModes.join(", ")}]`,
        "  default_on: true",
        "  fail_on_error: true",
        "  unreachable_fallback: fail_closed",
        "",
      ].join("\n");
  return {
    api_base_url: apiBaseUrl,
    callback_url: callbackUrl,
    stream_callback_url: isLiteLLM ? null : `${apiBaseUrl}/guardrails/output-stream`,
    auth_header: "x-api-key",
    credential_env_var: "TASKLATTICE_GUARD_API_KEY",
    api_base_env_var: "TASKLATTICE_GUARD_API_BASE",
    recommended_modes: recommendedModes,
    default_on: true,
    fail_on_error: true,
    unreachable_fallback: "fail_closed" as const,
    yaml_template: yamlTemplate,
  };
}
