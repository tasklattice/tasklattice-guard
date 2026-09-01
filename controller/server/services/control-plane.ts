import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";

import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, max, min, or, sql } from "drizzle-orm";

import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import {
  artifacts,
  auditEvents,
  controllerState,
  deployments,
  guardrails,
  guardrailVersions,
  integrations,
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
import { decodeRuntimeLogKey, decryptRuntimeLogPayload } from "../runtime-log-crypto.js";
import {
  DEFAULT_DEPLOYMENT_ID,
  DEFAULT_DEPLOYMENT_NAME,
  DEFAULT_GUARDRAIL_DESCRIPTION,
  DEFAULT_GUARDRAIL_ID,
  DEFAULT_GUARDRAIL_NAME,
  defaultGuardrailDraft,
} from "../domain/defaults.js";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors.js";
import { buildGuardrailPlan, normalizeGuardrailDraft, type GuardrailDraftConfig } from "../domain/guardrail-plan.js";
import type { CompiledArtifactInput, DeletionImpact, RuntimeEventInput, ValidationCaseResult, ValidationMetrics } from "../domain/models.js";
import { emptyValidationMetrics, generatedTestCases } from "../domain/validation.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { registeredAction } from "../action-catalog/catalog.js";
import type { ValidationTerminalState } from "../../shared/lifecycle.js";
import {
  flowRuleId,
  programmablePolicyDraftSchema,
  type PolicyValidationResult,
  type ProgrammablePolicyDraft,
  type ProgrammablePolicySnapshot,
} from "../policy-studio/model.js";
import {
  activeIntegrationCredentials,
  appendIntegrationCredential,
  issueIntegrationCredential,
  publicIntegrationCredentials,
  revokeIntegrationCredential,
} from "./integration-credentials.js";

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
  private catalog: PolicyCatalog | null = null;
  private readonly runtimeLogEncryptionKey: Buffer | null;

  constructor(
    private readonly db: ControllerDatabase,
    private readonly config: ControllerConfig,
  ) {
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
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('tasklattice-guard-product-defaults'))`);
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
        draftRevision: sql`${policyRecords.draftRevision} + 1`,
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
    return {
      valid: true,
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
      const snapshot = policySnapshot(record, String(record.draftRevision), "");
      snapshot.checksum = createHash("sha256").update(stableJson(snapshot)).digest("hex");
      const plan = programmablePolicyPlan(record.id, record.name, record.description, record.draftRevision, snapshot);
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
          candidateVersion: record.draftRevision,
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

  async latestPolicyValidation(id: string) {
    await this.policyRecord(id);
    const [run] = await this.db.select().from(policyValidationRuns)
      .where(eq(policyValidationRuns.policyId, id)).orderBy(desc(policyValidationRuns.createdAt)).limit(1);
    return run ? policyValidationPayload(run) : { status: "not_run" as const };
  }

  async publishPolicy(input: { id: string; actorId: string }) {
    return this.db.transaction(async (tx) => {
      const [record] = await tx.select().from(policyRecords).where(eq(policyRecords.id, input.id)).for("update");
      if (!record) throw new NotFoundError("Policy", input.id);
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
      await tx.insert(policyVersions).values({ policyId: input.id, version, snapshot, checksum, publishedAt });
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

  async getGuardrail(id: string) {
    const [guardrail] = await this.db.select().from(guardrails).where(and(eq(guardrails.id, id), isNull(guardrails.deletedAt)));
    if (!guardrail) throw new NotFoundError("Guardrail", id);
    const versions = await this.db.select().from(guardrailVersions)
      .where(eq(guardrailVersions.guardrailId, id)).orderBy(desc(guardrailVersions.version));
    const artifactRows = await this.db.select().from(artifacts).where(eq(artifacts.guardrailId, id));
    const artifactsById = new Map(artifactRows.map((artifact) => [artifact.id, artifact]));
    return {
      ...await this.guardrailSummary(guardrail),
      versions: versions.map((version) => ({
        ...version,
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
    const [versionRow] = await this.db.select({ value: max(guardrailVersions.version) })
      .from(guardrailVersions).where(eq(guardrailVersions.guardrailId, id));
    const candidateVersion = (versionRow?.value ?? 0) + 1;
    const draft = normalizeGuardrailDraft(guardrail.draftConfig);
    const programmablePolicies = await this.resolveProgrammablePolicies(draft);
    const plan = buildGuardrailPlan({
      guardrailId: id,
      guardrailVersion: candidateVersion,
      purpose: guardrail.description,
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
    description: string;
    draftConfig: GuardrailDraftConfig;
    runtimeProfile: string;
  }) {
    const draftConfig = normalizeGuardrailDraft(input.draftConfig);
    const programmablePolicies = await this.validateGuardrailDraft(input.description, draftConfig);
    const plan = buildGuardrailPlan({
      guardrailId: "draft-preview",
      guardrailVersion: 1,
      purpose: input.description,
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
      candidate_version: 1,
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
    description: string;
    draftConfig: GuardrailDraftConfig;
    runtimeProfile: string;
    actorId: string;
  }) {
    const draftConfig = normalizeGuardrailDraft(input.draftConfig);
    await this.validateGuardrailDraft(input.description, draftConfig);
    const id = randomUUID();
    const [created] = await this.db.transaction(async (tx) => {
      const rows = await tx.insert(guardrails).values({
        id,
        name: input.name,
        description: input.description,
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

  async updateGuardrail(input: {
    id: string;
    actorId: string;
    name?: string | undefined;
    description?: string | undefined;
    draftConfig?: GuardrailDraftConfig | undefined;
    runtimeProfile?: string | undefined;
  }) {
    const updated = await this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(guardrails).where(and(
        eq(guardrails.id, input.id), isNull(guardrails.deletedAt),
      )).for("update");
      if (!existing) throw new NotFoundError("Guardrail", input.id);
      const draftConfig = input.draftConfig ? normalizeGuardrailDraft(input.draftConfig) : normalizeGuardrailDraft(existing.draftConfig);
      const description = input.description ?? existing.description;
      await this.validateGuardrailDraft(description, draftConfig);
      const draftChanged = input.draftConfig !== undefined || input.description !== undefined;
      const nextExcluded = draftChanged ? await this.syncGeneratedTestCases(tx, input.id, draftConfig, existing.excludedTestCaseIds) : existing.excludedTestCaseIds;
      const [stored] = await tx.update(guardrails).set({
        name: input.name ?? existing.name,
        description,
        draftConfig,
        runtimeProfile: input.runtimeProfile ?? existing.runtimeProfile,
        ...(draftChanged ? {
          draftRevision: sql`${guardrails.draftRevision} + 1`,
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
  }) {
    return this.db.transaction(async (tx) => {
      const [guardrail] = await tx.select().from(guardrails).where(and(
        eq(guardrails.id, input.guardrailId), isNull(guardrails.deletedAt),
      )).for("update");
      if (!guardrail) throw new NotFoundError("Guardrail", input.guardrailId);
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
      const [existingVersion] = await tx.select().from(guardrailVersions).where(and(
        eq(guardrailVersions.guardrailId, input.guardrailId),
        eq(guardrailVersions.sourceDraftRevision, guardrail.draftRevision),
      )).orderBy(desc(guardrailVersions.version)).limit(1);
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
            .set({ desiredGeneration: sql`${controllerState.desiredGeneration} + 1`, updatedAt: new Date() })
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
          await tx.update(deployments).set({
            guardrailVersion: existingVersion.version,
            updatedAt: new Date(),
          }).where(and(eq(deployments.guardrailId, input.guardrailId), isNull(deployments.deletedAt)));
          if (input.guardrailId === DEFAULT_GUARDRAIL_ID) {
            await this.ensureDefaultDeployment(tx, existingVersion.version);
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
      if (!input.compilerAvailable) {
        throw new ConflictError(
          "A healthy GuardRails 0 Runner is required to compile Guardrail configurations.",
          "default_runner_unavailable",
        );
      }
      const [state] = await tx.update(controllerState)
        .set({ desiredGeneration: sql`${controllerState.desiredGeneration} + 1`, updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton"))
        .returning();
      if (!state) throw new Error("Controller state is not initialized.");
      const [versionRow] = await tx.select({ value: max(guardrailVersions.version) })
        .from(guardrailVersions).where(eq(guardrailVersions.guardrailId, input.guardrailId));
      const version = (versionRow?.value ?? 0) + 1;
      const programmablePolicies = await this.resolveProgrammablePolicies(normalizeGuardrailDraft(guardrail.draftConfig));
      const plan = buildGuardrailPlan({
        guardrailId: input.guardrailId,
        guardrailVersion: version,
        purpose: guardrail.description,
        draft: normalizeGuardrailDraft(guardrail.draftConfig),
        policies: this.policyCatalog().list(),
        programmablePolicies,
      });
      const compileId = randomUUID();
      await tx.insert(guardrailVersions).values({
        guardrailId: input.guardrailId,
        version,
        generation: state.desiredGeneration,
        sourceDraftRevision: guardrail.draftRevision,
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
      const [version] = await tx.select().from(guardrailVersions).where(and(
        eq(guardrailVersions.guardrailId, input.guardrailId),
        eq(guardrailVersions.version, input.guardrailVersion),
        eq(guardrailVersions.generation, input.generation),
      ));
      if (!version) throw new ConflictError("Compile result does not match an outstanding version.", "stale_compile_result");
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
      await tx.update(guardrails).set({
        status: "active",
        activeVersion: input.guardrailVersion,
        activeArtifactId: artifact.id,
        desiredGeneration: input.generation,
        updatedAt: new Date(),
      }).where(eq(guardrails.id, input.guardrailId));
      await tx.update(deployments).set({
        guardrailVersion: input.guardrailVersion,
        updatedAt: new Date(),
      }).where(and(eq(deployments.guardrailId, input.guardrailId), isNull(deployments.deletedAt)));
      if (input.guardrailId === DEFAULT_GUARDRAIL_ID) {
        await this.ensureDefaultDeployment(tx, input.guardrailVersion);
      }
      await tx.insert(outboxEvents).values({
        id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: input.guardrailId,
        payload: { guardrailId: input.guardrailId, generation: input.generation, artifactId: artifact.id },
      });
      await tx.update(outboxEvents).set({ processedAt: new Date() }).where(eq(outboxEvents.id, input.compileId));
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.compiled", actorId: null,
        resourceType: "guardrail", resourceId: input.guardrailId,
        detail: { version: input.guardrailVersion, generation: input.generation, artifactId: artifact.id, checksum },
      });
      return artifact;
    });
    return { artifactId: stored.id, checksum: stored.checksum, signature: stored.signature };
  }

  async rejectCompile(input: { compileId: string; guardrailId: string; guardrailVersion: number; reason: string }) {
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

  async rollbackGuardrail(input: { guardrailId: string; version: number; actorId: string }) {
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
        .set({ desiredGeneration: sql`${controllerState.desiredGeneration} + 1`, updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton")).returning();
      if (!state) throw new Error("Controller state is not initialized.");
      await tx.update(guardrails).set({
        status: "active",
        activeVersion: input.version,
        activeArtifactId: version.artifactId,
        desiredGeneration: state.desiredGeneration,
        updatedAt: new Date(),
      }).where(eq(guardrails.id, input.guardrailId));
      await tx.update(deployments).set({ guardrailVersion: input.version, updatedAt: new Date() })
        .where(and(eq(deployments.guardrailId, input.guardrailId), isNull(deployments.deletedAt)));
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
    const [guardrail] = await this.db.select({ excludedTestCaseIds: guardrails.excludedTestCaseIds })
      .from(guardrails).where(and(eq(guardrails.id, guardrailId), isNull(guardrails.deletedAt)));
    if (!guardrail) throw new NotFoundError("Guardrail", guardrailId);
    const excluded = new Set(guardrail.excludedTestCaseIds);
    const rows = await this.db.select().from(testCases).where(eq(testCases.guardrailId, guardrailId))
      .orderBy(asc(testCases.origin), asc(testCases.name), asc(testCases.id));
    return rows.map((item) => ({ ...item, excluded: excluded.has(item.id) }));
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
      await tx.update(guardrails).set({ draftRevision: sql`${guardrails.draftRevision} + 1`, updatedAt: new Date() })
        .where(eq(guardrails.id, input.guardrailId));
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.test_case_created", actorId: input.actorId,
        resourceType: "guardrail", resourceId: input.guardrailId, detail: { testCaseId: id },
      });
      return stored;
    });
    return { ...created, excluded: false };
  }

  async deleteTestCase(input: { caseId: string; actorId: string }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [item] = await tx.select().from(testCases).where(eq(testCases.id, input.caseId)).limit(1).for("update");
      if (!item) throw new NotFoundError("Test Case", input.caseId);
      if (item.origin !== "custom") throw new ValidationError("Only custom Test Cases can be deleted. Exclude inherited Policy cases instead.");
      await tx.delete(testCases).where(and(eq(testCases.guardrailId, item.guardrailId), eq(testCases.id, item.id)));
      await tx.update(guardrails).set({ draftRevision: sql`${guardrails.draftRevision} + 1`, updatedAt: new Date() })
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
        draftRevision: sql`${guardrails.draftRevision} + 1`,
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
      const rows = await tx.select().from(testCases).where(eq(testCases.guardrailId, input.guardrailId));
      const excluded = new Set(guardrail.excludedTestCaseIds);
      const activeCases = rows.filter((item) => !excluded.has(item.id));
      if (!activeCases.length) throw new ValidationError("Add at least one reviewed Test Case before running Validation.");
      const [versionRow] = await tx.select({ value: max(guardrailVersions.version) })
        .from(guardrailVersions).where(eq(guardrailVersions.guardrailId, input.guardrailId));
      const candidateVersion = (versionRow?.value ?? 0) + 1;
      const programmablePolicies = await this.resolveProgrammablePolicies(normalizeGuardrailDraft(guardrail.draftConfig));
      const plan = buildGuardrailPlan({
        guardrailId: input.guardrailId,
        guardrailVersion: candidateVersion,
        purpose: guardrail.description,
        draft: normalizeGuardrailDraft(guardrail.draftConfig),
        policies: this.policyCatalog().list(),
        programmablePolicies,
      });
      const runId = `validation-${randomUUID()}`;
      await tx.insert(validationRuns).values({
        id: runId,
        guardrailId: input.guardrailId,
        sourceDraftRevision: guardrail.draftRevision,
        status: "queued",
        metrics: emptyValidationMetrics(activeCases.length),
        results: [],
        excludedCaseIds: [...excluded],
        createdBy: input.actorId,
      });
      await tx.insert(outboxEvents).values({
        id: runId,
        kind: "guardrail.validation_requested",
        aggregateId: input.guardrailId,
        payload: {
          runId,
          guardrailId: input.guardrailId,
          candidateVersion,
          sourceDraftRevision: guardrail.draftRevision,
          plan,
          runtimeProfile: guardrail.runtimeProfile,
          testCases: activeCases,
        },
      });
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.validation_requested", actorId: input.actorId,
        resourceType: "guardrail", resourceId: input.guardrailId,
        detail: { runId, sourceDraftRevision: guardrail.draftRevision, testCaseCount: activeCases.length },
      });
      return (await tx.select().from(validationRuns).where(eq(validationRuns.id, runId)))[0]!;
    });
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
    await this.db.transaction(async (tx) => {
      const [run] = await tx.select().from(validationRuns).where(eq(validationRuns.id, input.runId)).for("update");
      if (!run) throw new NotFoundError("Validation Run", input.runId);
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
        .set({ desiredGeneration: sql`${controllerState.desiredGeneration} + 1`, updatedAt: new Date() })
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

  async listIntegrations() {
    const rows = await this.db.select().from(integrations)
      .where(isNull(integrations.deletedAt)).orderBy(desc(integrations.updatedAt));
    return rows.map((integration) => this.publicIntegration(integration));
  }

  async getIntegration(id: string) {
    const [integration] = await this.db.select().from(integrations)
      .where(and(eq(integrations.id, id), isNull(integrations.deletedAt)));
    if (!integration) throw new NotFoundError("Integration", id);
    return this.publicIntegration(integration);
  }

  async listDeployments() {
    const rows = await this.db.select({ deployment: deployments }).from(deployments)
      .leftJoin(integrations, eq(deployments.integrationId, integrations.id))
      .where(and(
        isNull(deployments.deletedAt),
        or(
          isNull(deployments.integrationId),
          and(isNotNull(integrations.id), isNull(integrations.deletedAt)),
        ),
      ))
      .orderBy(asc(deployments.integrationId), asc(deployments.routeOrder), asc(deployments.id));
    return rows.map((row) => row.deployment);
  }

  async getDeployment(id: string) {
    const [deployment] = await this.db.select().from(deployments)
      .where(and(eq(deployments.id, id), isNull(deployments.deletedAt)));
    if (!deployment) throw new NotFoundError("Deployment", id);
    return deployment;
  }

  async listRuntimeEvents(limit = 100) {
    return (await this.queryRuntimeEvents({ limit })).items;
  }

  async queryRuntimeEvents(input: {
    limit?: number | undefined;
    guardrailId?: string | undefined;
    deploymentId?: string | undefined;
    integrationId?: string | undefined;
    since?: Date | undefined;
    before?: Date | undefined;
  }) {
    const conditions = [
      input.guardrailId ? eq(runtimeEvents.guardrailId, input.guardrailId) : undefined,
      input.deploymentId ? eq(runtimeEvents.deploymentId, input.deploymentId) : undefined,
      input.integrationId ? eq(runtimeEvents.integrationId, input.integrationId) : undefined,
      input.since ? gte(runtimeEvents.occurredAt, input.since) : undefined,
      input.before ? lte(runtimeEvents.occurredAt, input.before) : undefined,
    ].filter((item): item is NonNullable<typeof item> => Boolean(item));
    const predicate = conditions.length ? and(...conditions) : undefined;
    let itemsQuery = this.db.select().from(runtimeEvents).$dynamic();
    let countQuery = this.db.select({ value: count() }).from(runtimeEvents).$dynamic();
    if (predicate) {
      itemsQuery = itemsQuery.where(predicate);
      countQuery = countQuery.where(predicate);
    }
    const [items, totals] = await Promise.all([
      itemsQuery.orderBy(desc(runtimeEvents.occurredAt)).limit(input.limit ?? 100),
      countQuery,
    ]);
    return {
      items: items.map((item) => ({
        ...item,
        metadata: decryptRuntimeEventMetadata(item.metadata, this.runtimeLogEncryptionKey),
      })),
      count: totals[0]?.value ?? 0,
    };
  }

  async listAuditEvents(limit = 100) {
    return this.db.select().from(auditEvents).orderBy(desc(auditEvents.occurredAt)).limit(limit);
  }

  async createDeployment(input: {
    name: string;
    guardrailId: string;
    integrationId: string;
    poolId: string;
    trafficScope: Record<string, unknown>;
    enabled?: boolean | undefined;
    actorId: string;
  }) {
    const created = await this.createDeploymentBindings({
      ...input,
      integrationIds: [input.integrationId],
    });
    return created[0]!;
  }

  async createDeploymentBindings(input: {
    name: string;
    guardrailId: string;
    integrationIds: string[];
    poolId: string;
    trafficScope: Record<string, unknown>;
    enabled?: boolean | undefined;
    actorId: string;
  }) {
    const uniqueIntegrationIds = [...new Set(input.integrationIds)];
    if (!uniqueIntegrationIds.length) throw new ValidationError("Select at least one Integration for a Deployment.");
    return this.db.transaction(async (tx) => {
      const [guardrail] = await tx.select().from(guardrails).where(and(
        eq(guardrails.id, input.guardrailId), eq(guardrails.status, "active"), isNull(guardrails.deletedAt),
      ));
      if (!guardrail?.activeArtifactId || !guardrail.activeVersion) {
        throw new ConflictError("Only a compiled active Guardrail can be deployed.", "guardrail_not_active");
      }
      const [pool] = await tx.select().from(runnerPools).where(eq(runnerPools.id, input.poolId));
      if (!pool) throw new NotFoundError("Runner Pool", input.poolId);
      for (const integrationId of [...uniqueIntegrationIds].sort()) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${integrationId}))`);
      }
      const integrationRows = await tx.select().from(integrations).where(and(
        inArray(integrations.id, uniqueIntegrationIds), eq(integrations.status, "active"), isNull(integrations.deletedAt),
      ));
      const activeIds = new Set(integrationRows.map((item) => item.id));
      const missing = uniqueIntegrationIds.filter((id) => !activeIds.has(id));
      if (missing.length) throw new ValidationError(`Active Integrations were not found: ${missing.join(", ")}.`);
      const created: Array<typeof deployments.$inferSelect> = [];
      for (const integrationId of uniqueIntegrationIds) {
        const routes = await tx.select().from(deployments)
          .where(and(eq(deployments.integrationId, integrationId), isNull(deployments.deletedAt)))
          .orderBy(asc(deployments.routeOrder), asc(deployments.id)).for("update");
        assertCatchAllTopology(routes);
        const catchAll = routes.find((item) => isCatchAllTrafficScope(item.trafficScope));
        const insertingCatchAll = isCatchAllTrafficScope(input.trafficScope);
        if (insertingCatchAll && catchAll) {
          throw new ConflictError(
            "An Integration can have only one catch-all Deployment.",
            "deployment_catch_all_conflict",
          );
        }
        const routeOrder = !insertingCatchAll && catchAll
          ? catchAll.routeOrder
          : (routes.at(-1)?.routeOrder ?? -1) + 1;
        if (!insertingCatchAll && catchAll) {
          for (const route of [...routes].reverse()) {
            if (route.routeOrder < routeOrder) continue;
            await tx.update(deployments).set({ routeOrder: route.routeOrder + 1 })
              .where(eq(deployments.id, route.id));
          }
        }
        const id = randomUUID();
        const [row] = await tx.insert(deployments).values({
          id,
          name: uniqueIntegrationIds.length === 1 ? input.name : `${input.name} · ${integrationRows.find((item) => item.id === integrationId)?.name ?? integrationId}`,
          guardrailId: input.guardrailId,
          guardrailVersion: guardrail.activeVersion,
          integrationId,
          poolId: input.poolId,
          routeOrder,
          enabled: input.enabled ?? true,
          trafficScope: input.trafficScope,
        }).returning();
        if (!row) throw new Error("Deployment creation did not return the stored resource.");
        created.push(row);
      }
      const [state] = await tx.update(controllerState)
        .set({ desiredGeneration: sql`${controllerState.desiredGeneration} + 1`, updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton")).returning();
      if (!state) throw new Error("Controller state is not initialized.");
      await tx.insert(outboxEvents).values({
        id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: input.guardrailId,
        payload: { deploymentIds: created.map((item) => item.id), generation: state.desiredGeneration },
      });
      await tx.insert(auditEvents).values(created.map((item) => ({
        id: randomUUID(), kind: "deployment.created", actorId: input.actorId,
        resourceType: "deployment", resourceId: item.id,
        detail: { guardrailId: input.guardrailId, integrationId: item.integrationId, poolId: input.poolId, routeOrder: item.routeOrder },
      })));
      return created;
    });
  }

  async setDeploymentEnabled(input: { id: string; enabled: boolean; actorId: string }) {
    return this.mutateDeployment(input.id, input.actorId, input.enabled ? "deployment.enabled" : "deployment.disabled", async (tx, current) => {
      if (current.enabled === input.enabled) return current;
      const [updated] = await tx.update(deployments).set({ enabled: input.enabled, updatedAt: new Date() })
        .where(eq(deployments.id, input.id)).returning();
      return updated!;
    });
  }

  async updateDeploymentTrafficScope(input: { id: string; trafficScope: Record<string, unknown>; actorId: string }) {
    return this.mutateDeployment(input.id, input.actorId, "deployment.traffic_scope_updated", async (tx, current) => {
      if (!current.integrationId) throw new ValidationError("The global fallback Deployment is system managed.");
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${current.integrationId}))`);
      const routes = await tx.select().from(deployments)
        .where(and(eq(deployments.integrationId, current.integrationId), isNull(deployments.deletedAt)))
        .orderBy(asc(deployments.routeOrder), asc(deployments.id)).for("update");
      assertCatchAllTopology(routes.map((route) => route.id === input.id
        ? { ...route, trafficScope: input.trafficScope }
        : route));
      const [updated] = await tx.update(deployments).set({ trafficScope: input.trafficScope, updatedAt: new Date() })
        .where(eq(deployments.id, input.id)).returning();
      return updated!;
    });
  }

  async reorderDeploymentRoutes(input: { integrationId: string; deploymentIds: string[]; actorId: string }) {
    if (new Set(input.deploymentIds).size !== input.deploymentIds.length) throw new ValidationError("Deployment route order contains duplicate IDs.");
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.integrationId}))`);
      const current = await tx.select().from(deployments)
        .where(and(eq(deployments.integrationId, input.integrationId), isNull(deployments.deletedAt)))
        .orderBy(asc(deployments.routeOrder), asc(deployments.id)).for("update");
      const expected = new Set(current.map((item) => item.id));
      if (current.length !== input.deploymentIds.length || input.deploymentIds.some((id) => !expected.has(id))) {
        throw new ConflictError("Route order must include every Deployment for the Integration exactly once.", "deployment_order_conflict");
      }
      const byId = new Map(current.map((item) => [item.id, item]));
      assertCatchAllTopology(input.deploymentIds.map((id, routeOrder) => ({ ...byId.get(id)!, routeOrder })));
      for (const item of current) {
        await tx.update(deployments).set({ routeOrder: -item.routeOrder - 1 }).where(eq(deployments.id, item.id));
      }
      for (const [routeOrder, id] of input.deploymentIds.entries()) {
        await tx.update(deployments).set({ routeOrder, updatedAt: new Date() }).where(eq(deployments.id, id));
      }
      await this.advanceDeploymentDesiredState(tx, input.integrationId, input.actorId, "deployment.routes_reordered", {
        deploymentIds: input.deploymentIds,
      });
      return tx.select().from(deployments)
        .where(and(eq(deployments.integrationId, input.integrationId), isNull(deployments.deletedAt)))
        .orderBy(asc(deployments.routeOrder), asc(deployments.id));
    });
  }

  async createIntegration(input: { name: string; adapter: string; actorId: string }) {
    const id = randomUUID();
    const issued = issueIntegrationCredential();
    const verification = { credentials: [issued.stored] };
    const [created] = await this.db.transaction(async (tx) => {
      const rows = await tx.insert(integrations).values({
        id, name: input.name, adapter: input.adapter, verification,
      }).returning();
      await this.advanceIntegrationDesiredState(tx, {
        integrationId: id,
        actorId: input.actorId,
        auditKind: "integration.created",
        auditDetail: { name: input.name, adapter: input.adapter, credentialId: issued.stored.id },
      });
      if (!rows[0]) throw new Error("Integration creation did not return the stored resource.");
      return rows;
    });
    if (!created) throw new Error("Integration creation did not return the stored resource.");
    return {
      ...this.publicIntegration(created),
      credential: issued.value,
      credentialId: issued.publicCredential.id,
      credentialKeyHint: issued.publicCredential.keyHint,
      credentialCreatedAt: issued.publicCredential.createdAt,
    };
  }

  async setIntegrationEnabled(input: { id: string; enabled: boolean; actorId: string }) {
    return this.db.transaction(async (tx) => {
      const [integration] = await tx.select().from(integrations)
        .where(and(eq(integrations.id, input.id), isNull(integrations.deletedAt))).for("update");
      if (!integration) throw new NotFoundError("Integration", input.id);
      const status = input.enabled ? "active" : "disabled";
      if (integration.status === status) return this.publicIntegration(integration);

      const now = new Date();
      const [updated] = await tx.update(integrations).set({ status, updatedAt: now })
        .where(and(eq(integrations.id, input.id), isNull(integrations.deletedAt))).returning();
      if (!updated) throw new NotFoundError("Integration", input.id);
      await this.advanceIntegrationDesiredState(tx, {
        integrationId: input.id,
        actorId: input.actorId,
        auditKind: input.enabled ? "integration.enabled" : "integration.disabled",
        auditDetail: { previousStatus: integration.status, status },
      });
      return this.publicIntegration(updated);
    });
  }

  async rotateIntegrationCredential(input: { id: string; actorId: string }) {
    const issued = issueIntegrationCredential();
    const updated = await this.db.transaction(async (tx) => {
      const [integration] = await tx.select().from(integrations)
        .where(and(eq(integrations.id, input.id), isNull(integrations.deletedAt))).for("update");
      if (!integration) throw new NotFoundError("Integration", input.id);
      const verification = appendIntegrationCredential(integration.verification, issued.stored);
      const [stored] = await tx.update(integrations).set({ verification, updatedAt: new Date() })
        .where(and(eq(integrations.id, input.id), isNull(integrations.deletedAt))).returning();
      if (!stored) throw new NotFoundError("Integration", input.id);
      await this.advanceIntegrationDesiredState(tx, {
        integrationId: input.id,
        actorId: input.actorId,
        auditKind: "integration.credential_rotated",
        auditDetail: { credentialId: issued.stored.id, keyHint: issued.stored.keyHint },
      });
      return stored;
    });
    return {
      ...this.publicIntegration(updated),
      credential: issued.value,
      credentialId: issued.publicCredential.id,
      credentialKeyHint: issued.publicCredential.keyHint,
      credentialCreatedAt: issued.publicCredential.createdAt,
    };
  }

  async revokeIntegrationCredential(input: { id: string; credentialId: string; actorId: string }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [integration] = await tx.select().from(integrations)
        .where(and(eq(integrations.id, input.id), isNull(integrations.deletedAt))).for("update");
      if (!integration) throw new NotFoundError("Integration", input.id);
      const activeCredentials = activeIntegrationCredentials(integration.verification);
      if (!activeCredentials.some((credential) => credential.id === input.credentialId)) {
        throw new NotFoundError("Integration credential", input.credentialId);
      }
      if (activeCredentials.length === 1) {
        throw new ConflictError(
          "An Integration must retain at least one active credential.",
          "last_integration_credential",
        );
      }
      const verification = revokeIntegrationCredential(integration.verification, input.credentialId, new Date());
      if (!verification) throw new NotFoundError("Integration credential", input.credentialId);
      const updated = await tx.update(integrations).set({ verification, updatedAt: new Date() })
        .where(and(eq(integrations.id, input.id), isNull(integrations.deletedAt))).returning({ id: integrations.id });
      if (!updated[0]) throw new NotFoundError("Integration", input.id);
      await this.advanceIntegrationDesiredState(tx, {
        integrationId: input.id,
        actorId: input.actorId,
        auditKind: "integration.credential_revoked",
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
    const activeDeployments = await this.db.select({ poolId: deployments.poolId }).from(deployments)
      .where(and(eq(deployments.guardrailId, id), eq(deployments.enabled, true), isNull(deployments.deletedAt)));
    return this.deletionImpact("guardrail", id, activeDeployments.map((item) => item.poolId));
  }

  async integrationDeletionImpact(id: string): Promise<DeletionImpact> {
    const [resource] = await this.db.select().from(integrations).where(and(eq(integrations.id, id), isNull(integrations.deletedAt)));
    if (!resource) throw new NotFoundError("Integration", id);
    const activeDeployments = await this.db.select({ poolId: deployments.poolId }).from(deployments)
      .where(and(eq(deployments.integrationId, id), eq(deployments.enabled, true), isNull(deployments.deletedAt)));
    return this.deletionImpact("integration", id, activeDeployments.map((item) => item.poolId));
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
      const [state] = await tx.update(controllerState)
        .set({ desiredGeneration: sql`${controllerState.desiredGeneration} + 1`, updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton")).returning();
      if (!state) throw new Error("Controller state is not initialized.");
      const disabled = await tx.update(guardrails).set({
        status: "disabled", deletedAt: new Date(), deletedBy: input.actorId,
        deleteReason: input.reason, desiredGeneration: state.desiredGeneration, updatedAt: new Date(),
      }).where(and(eq(guardrails.id, input.id), isNull(guardrails.deletedAt))).returning({ id: guardrails.id });
      if (!disabled[0]) throw new NotFoundError("Guardrail", input.id);
      await tx.update(deployments).set({ enabled: false, updatedAt: new Date() })
        .where(and(eq(deployments.guardrailId, input.id), isNull(deployments.deletedAt)));
      await this.recordSoftDelete(tx, "guardrail", input, impact, state.desiredGeneration);
    });
  }

  async softDeleteIntegration(input: { id: string; actorId: string; reason: string; confirmRecentTraffic: boolean; confirmationName?: string | undefined }) {
    const [resource] = await this.db.select({ name: integrations.name }).from(integrations)
      .where(and(eq(integrations.id, input.id), isNull(integrations.deletedAt)));
    if (!resource) throw new NotFoundError("Integration", input.id);
    const impact = await this.integrationDeletionImpact(input.id);
    this.assertDeletionAllowed(impact, input.confirmRecentTraffic, input.confirmationName, resource.name);
    await this.db.transaction(async (tx) => {
      const [state] = await tx.update(controllerState)
        .set({ desiredGeneration: sql`${controllerState.desiredGeneration} + 1`, updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton")).returning();
      if (!state) throw new Error("Controller state is not initialized.");
      const disabled = await tx.update(integrations).set({
        status: "disabled", deletedAt: new Date(), deletedBy: input.actorId,
        deleteReason: input.reason, updatedAt: new Date(),
      }).where(and(eq(integrations.id, input.id), isNull(integrations.deletedAt))).returning({ id: integrations.id });
      if (!disabled[0]) throw new NotFoundError("Integration", input.id);
      await tx.update(deployments).set({ enabled: false, updatedAt: new Date() })
        .where(and(eq(deployments.integrationId, input.id), isNull(deployments.deletedAt)));
      await this.recordSoftDelete(tx, "integration", input, impact, state.desiredGeneration);
    });
  }

  async deploymentDeletionImpact(id: string): Promise<DeletionImpact> {
    if (id === DEFAULT_DEPLOYMENT_ID) {
      throw new ValidationError("The Default Deployment cannot be removed because it protects unmatched traffic.");
    }
    const [resource] = await this.db.select({ poolId: deployments.poolId, enabled: deployments.enabled })
      .from(deployments).where(and(eq(deployments.id, id), isNull(deployments.deletedAt)));
    if (!resource) throw new NotFoundError("Deployment", id);
    return this.deletionImpact("deployment", id, resource.enabled ? [resource.poolId] : []);
  }

  async softDeleteDeployment(input: { id: string; actorId: string; reason: string; confirmRecentTraffic: boolean; confirmationName?: string | undefined }) {
    if (input.id === DEFAULT_DEPLOYMENT_ID) {
      throw new ValidationError("The Default Deployment cannot be removed because it protects unmatched traffic.");
    }
    const [resource] = await this.db.select({
      name: deployments.name,
      integrationId: deployments.integrationId,
      guardrailId: deployments.guardrailId,
    }).from(deployments).where(and(eq(deployments.id, input.id), isNull(deployments.deletedAt)));
    if (!resource) throw new NotFoundError("Deployment", input.id);
    const impact = await this.deploymentDeletionImpact(input.id);
    this.assertDeletionAllowed(impact, input.confirmRecentTraffic, input.confirmationName, resource.name);
    await this.db.transaction(async (tx) => {
      if (resource.integrationId) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${resource.integrationId}))`);
      }
      const [state] = await tx.update(controllerState)
        .set({ desiredGeneration: sql`${controllerState.desiredGeneration} + 1`, updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton")).returning();
      if (!state) throw new Error("Controller state is not initialized.");
      const deleted = await tx.update(deployments).set({
        enabled: false,
        deletedAt: new Date(),
        deletedBy: input.actorId,
        deleteReason: input.reason,
        updatedAt: new Date(),
      }).where(and(eq(deployments.id, input.id), isNull(deployments.deletedAt))).returning({ id: deployments.id });
      if (!deleted[0]) throw new NotFoundError("Deployment", input.id);
      await tx.insert(auditEvents).values({
        id: randomUUID(),
        kind: "deployment.deleted",
        actorId: input.actorId,
        resourceType: "deployment",
        resourceId: input.id,
        detail: {
          reason: input.reason,
          impact,
          generation: state.desiredGeneration,
          integrationId: resource.integrationId,
          guardrailId: resource.guardrailId,
        },
      });
      await tx.insert(outboxEvents).values({
        id: randomUUID(),
        kind: "runner.desired_state_changed",
        aggregateId: input.id,
        payload: {
          resourceType: "deployment",
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
          integrationId: event.integrationId ?? null,
          deploymentId: event.deploymentId ?? null,
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
      .where(and(lte(runnerInstances.lastHeartbeatAt, cutoff), sql`${runnerInstances.status} <> 'offline'`));
  }

  async desiredStateForPool(poolId: string) {
    const generation = await this.desiredGeneration();
    const activeArtifacts = poolId === "default"
      ? await this.db.select({ artifact: artifacts }).from(guardrailVersions)
        .innerJoin(guardrails, and(eq(guardrails.id, guardrailVersions.guardrailId), isNull(guardrails.deletedAt)))
        .innerJoin(artifacts, eq(artifacts.id, guardrailVersions.artifactId))
        .where(eq(guardrailVersions.status, "ready"))
      : await this.db.select({ artifact: artifacts }).from(deployments)
        .innerJoin(guardrails, and(eq(guardrails.id, deployments.guardrailId), eq(guardrails.status, "active")))
        .innerJoin(guardrailVersions, and(
          eq(guardrailVersions.guardrailId, deployments.guardrailId),
          sql`${guardrailVersions.version} = coalesce(${deployments.guardrailVersion}, ${guardrails.activeVersion})`,
          eq(guardrailVersions.status, "ready"),
        ))
        .innerJoin(artifacts, eq(artifacts.id, guardrailVersions.artifactId))
        .where(and(eq(deployments.poolId, poolId), eq(deployments.enabled, true), isNull(deployments.deletedAt)));
    const disabledGuardrails = await this.db.select({ id: guardrails.id }).from(guardrails).where(eq(guardrails.status, "disabled"));
    const loggingLevels = await this.db.select({ id: guardrails.id, level: guardrails.loggingLevel })
      .from(guardrails).where(isNull(guardrails.deletedAt));
    const disabledIntegrations = await this.db.select({ id: integrations.id }).from(integrations).where(eq(integrations.status, "disabled"));
    const routes = await this.db.select({
      deploymentId: deployments.id,
      guardrailId: deployments.guardrailId,
      artifactId: guardrailVersions.artifactId,
      integrationId: deployments.integrationId,
      trafficScope: deployments.trafficScope,
      routeOrder: deployments.routeOrder,
    }).from(deployments)
      .innerJoin(guardrails, and(eq(guardrails.id, deployments.guardrailId), eq(guardrails.status, "active")))
      .innerJoin(guardrailVersions, and(
        eq(guardrailVersions.guardrailId, deployments.guardrailId),
        sql`${guardrailVersions.version} = coalesce(${deployments.guardrailVersion}, ${guardrails.activeVersion})`,
        eq(guardrailVersions.status, "ready"),
      ))
      .where(and(eq(deployments.poolId, poolId), eq(deployments.enabled, true), isNull(deployments.deletedAt)))
      .orderBy(asc(deployments.routeOrder), asc(deployments.id));
    const integrationRows = await this.db.select().from(integrations).where(eq(integrations.status, "active"));
    return {
      generation,
      artifacts: [...new Map(activeArtifacts.map((row) => [row.artifact.id, row.artifact])).values()],
      disabledGuardrailIds: disabledGuardrails.map((row) => row.id),
      disabledIntegrationIds: disabledIntegrations.map((row) => row.id),
      deployments: routes.filter((route) => route.artifactId !== null).map((route) => ({
        ...route,
        artifactId: route.artifactId as string,
        integrationId: route.integrationId,
      })),
      integrations: integrationRows.map((integration) => ({
        integrationId: integration.id,
        adapter: integration.adapter,
        verification: integration.verification,
      })),
      guardrailLoggingLevels: Object.fromEntries(loggingLevels.map((item) => [item.id, item.level])),
    };
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
    const [watermarks, pendingOutbox, guardrailRows, deploymentRows, integrationRows] = await Promise.all([
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
        id: deployments.id,
        name: deployments.name,
        guardrailId: deployments.guardrailId,
        guardrailVersion: deployments.guardrailVersion,
        integrationId: deployments.integrationId,
        poolId: deployments.poolId,
        enabled: deployments.enabled,
      }).from(deployments).where(isNull(deployments.deletedAt)),
      this.db.select({
        id: integrations.id,
        name: integrations.name,
        adapter: integrations.adapter,
        status: integrations.status,
        deletedAt: integrations.deletedAt,
      }).from(integrations),
    ]);
    const guardrailById = new Map(guardrailRows.map((item) => [item.id, item]));
    const integrationById = new Map(integrationRows.map((item) => [item.id, item]));
    const integrationBindings = new Map<string, {
      guardrailId: string;
      integrationId: string;
      integrationName: string;
      poolId: string;
      status: "active" | "inactive" | "disabled";
    }>();
    const deploymentTopology = deploymentRows.flatMap((item) => {
      const guardrail = guardrailById.get(item.guardrailId);
      if (!guardrail) return [];
      const integration = item.integrationId === null ? null : integrationById.get(item.integrationId);
      const guardrailVersion = item.guardrailVersion ?? guardrail.activeVersion;
      const status = !item.enabled
        ? "disabled"
        : guardrail.status !== "active"
          || guardrailVersion === null
          || (item.integrationId !== null && (!integration || integration.status !== "active" || integration.deletedAt !== null))
          ? "inactive"
          : "active";
      if (item.integrationId !== null && integration?.deletedAt === null) {
        const key = `${item.guardrailId}\u0000${item.integrationId}\u0000${item.poolId}`;
        const current = integrationBindings.get(key);
        const priority = { disabled: 0, inactive: 1, active: 2 } as const;
        if (!current || priority[status] > priority[current.status]) {
          integrationBindings.set(key, {
            guardrailId: item.guardrailId,
            integrationId: item.integrationId,
            integrationName: integration.name,
            poolId: item.poolId,
            status,
          });
        }
      }
      return [{
        guardrailId: item.guardrailId,
        guardrailVersion,
        deploymentId: item.id,
        deploymentName: item.name,
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
      integrations: integrationRows.filter((item) => item.deletedAt === null).map((item) => ({
        integrationId: item.id,
        integrationName: item.name,
        adapter: item.adapter,
        status: item.status,
      })),
      integrationBindings: [...integrationBindings.values()],
      deployments: deploymentTopology,
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
      attempts: sql`${outboxEvents.attempts} + 1`,
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
    const declarations = new Set<string>();
    for (const source of draft.sources) {
      for (const match of source.content.matchAll(/^flow\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm)) {
        const name = match[1]!;
        if (declarations.has(name)) throw new ValidationError(`Policy ${id} declares duplicate Flow ${name}.`);
        declarations.add(name);
      }
      for (const match of source.content.matchAll(/^\s*import\s+([^\s#]+)/gm)) {
        if (match[1] !== "core") throw new ValidationError(`Policy ${id} uses forbidden import ${match[1]}.`);
      }
    }
    if (declarations.has("main")) throw new ValidationError("A Policy must not declare the process-wide main Flow.");
    const missingFlows = [...bindingNames].filter((name) => !declarations.has(name));
    if (missingFlows.length) throw new ValidationError(`Policy Rail bindings reference undefined Flows: ${missingFlows.join(", ")}.`);
    const actionReferences = new Set(draft.action_references.map((item) => `${item.name}@${item.version}`));
    for (const reference of draft.action_references) {
      if (!registeredAction(reference.name, reference.version)) {
        throw new ValidationError(`Policy ${id} references unregistered Action ${reference.name}@${reference.version}.`);
      }
    }
    for (const source of draft.sources) {
      for (const match of source.content.matchAll(/\b(?:await|start)\s+([A-Z][A-Za-z0-9_]*Action)\s*\(/g)) {
        if (!actionReferences.has(`${match[1]}@1.0.0`)) {
          throw new ValidationError(`Policy ${id} calls unreferenced Action ${match[1]}.`);
        }
      }
    }
    for (const binding of draft.rail_bindings) {
      if (binding.execution_mode === "mutate" && binding.priority === null) {
        throw new ValidationError(`Mutating Flow ${binding.flow_name} requires an explicit priority.`);
      }
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
        description: DEFAULT_GUARDRAIL_DESCRIPTION,
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
        detail: { localOnly: true, phases: ["input"], policies: desiredDraft.policyBindings.map((item) => item.policyId) },
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
    if (!userCustomization && stableJson(normalizeGuardrailDraft(stored.draftConfig)) !== stableJson(desiredDraft)) {
      const nextExcluded = await this.syncGeneratedTestCases(
        tx,
        DEFAULT_GUARDRAIL_ID,
        desiredDraft,
        stored.excludedTestCaseIds,
      );
      const [upgraded] = await tx.update(guardrails).set({
        draftConfig: desiredDraft,
        draftRevision: sql`${guardrails.draftRevision} + 1`,
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

    if (stored.activeArtifactId && stored.activeVersion && !baselineChanged) {
      const deploymentChanged = await this.ensureDefaultDeployment(tx, stored.activeVersion);
      if (restored || deploymentChanged) {
        const [state] = await tx.update(controllerState)
          .set({ desiredGeneration: sql`${controllerState.desiredGeneration} + 1`, updatedAt: new Date() })
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

    const [compiling] = await tx.select({ version: guardrailVersions.version }).from(guardrailVersions).where(and(
      eq(guardrailVersions.guardrailId, DEFAULT_GUARDRAIL_ID),
      eq(guardrailVersions.status, "compiling"),
    )).limit(1);
    if (compiling) return;

    const [state] = await tx.update(controllerState)
      .set({ desiredGeneration: sql`${controllerState.desiredGeneration} + 1`, updatedAt: new Date() })
      .where(eq(controllerState.id, "singleton")).returning();
    if (!state) throw new Error("Controller state is not initialized.");
    const [versionRow] = await tx.select({ value: max(guardrailVersions.version) })
      .from(guardrailVersions).where(eq(guardrailVersions.guardrailId, DEFAULT_GUARDRAIL_ID));
    const version = (versionRow?.value ?? 0) + 1;
    const plan = buildGuardrailPlan({
      guardrailId: DEFAULT_GUARDRAIL_ID,
      guardrailVersion: version,
      purpose: stored.description,
      draft: normalizeGuardrailDraft(stored.draftConfig),
      policies: this.policyCatalog().list(),
    });
    const compileId = randomUUID();
    await tx.insert(guardrailVersions).values({
      guardrailId: DEFAULT_GUARDRAIL_ID,
      version,
      generation: state.desiredGeneration,
      sourceDraftRevision: stored.draftRevision,
      status: "compiling",
      runtimeProfile: stored.runtimeProfile,
      plan,
      createdBy: null,
    });
    await tx.update(guardrails).set({
      status: "draft",
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
      detail: { version, generation: state.desiredGeneration, sourceDraftRevision: stored.draftRevision },
    });
  }

  private async ensureDefaultDeployment(
    tx: Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0],
    guardrailVersion: number,
  ): Promise<boolean> {
    const [existing] = await tx.select().from(deployments)
      .where(eq(deployments.id, DEFAULT_DEPLOYMENT_ID)).for("update");
    if (!existing) {
      await tx.insert(deployments).values({
        id: DEFAULT_DEPLOYMENT_ID,
        name: DEFAULT_DEPLOYMENT_NAME,
        guardrailId: DEFAULT_GUARDRAIL_ID,
        guardrailVersion,
        integrationId: null,
        poolId: "default",
        routeOrder: 100,
        enabled: true,
        trafficScope: { combinator: "and", conditions: [] },
      });
      await tx.insert(auditEvents).values({
        id: randomUUID(),
        kind: "deployment.default.created",
        actorId: null,
        resourceType: "deployment",
        resourceId: DEFAULT_DEPLOYMENT_ID,
        detail: { guardrailId: DEFAULT_GUARDRAIL_ID, guardrailVersion, poolId: "default" },
      });
      return true;
    }
    const changed = (
      existing.guardrailId !== DEFAULT_GUARDRAIL_ID
      || existing.guardrailVersion !== guardrailVersion
      || existing.integrationId !== null
      || existing.poolId !== "default"
      || existing.routeOrder !== 100
      || !existing.enabled
      || !isCatchAllTrafficScope(existing.trafficScope)
    );
    if (!changed) return false;
    await tx.update(deployments).set({
      name: DEFAULT_DEPLOYMENT_NAME,
      guardrailId: DEFAULT_GUARDRAIL_ID,
      guardrailVersion,
      integrationId: null,
      poolId: "default",
      routeOrder: 100,
      enabled: true,
      trafficScope: { combinator: "and", conditions: [] },
      updatedAt: new Date(),
    }).where(eq(deployments.id, DEFAULT_DEPLOYMENT_ID));
    await tx.insert(auditEvents).values({
      id: randomUUID(),
      kind: "deployment.default.restored",
      actorId: null,
      resourceType: "deployment",
      resourceId: DEFAULT_DEPLOYMENT_ID,
      detail: { guardrailId: DEFAULT_GUARDRAIL_ID, guardrailVersion, poolId: "default" },
    });
    return true;
  }

  private async validateGuardrailDraft(purpose: string, draft: GuardrailDraftConfig): Promise<ProgrammablePolicySnapshot[]> {
    if (!purpose.trim()) throw new ValidationError("A Guardrail requires a clear purpose.");
    try {
      const programmablePolicies = await this.resolveProgrammablePolicies(draft);
      buildGuardrailPlan({
        guardrailId: "guardrail-draft-validation",
        guardrailVersion: 1,
        purpose,
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
    return {
      ...row,
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
    await tx.delete(testCases).where(and(eq(testCases.guardrailId, guardrailId), eq(testCases.origin, "generated")));
    if (generated.length) await tx.insert(testCases).values(generated);
    const generatedIds = new Set(generated.map((item) => item.id));
    return priorExcluded.filter((id) => generatedIds.has(id));
  }

  private publicIntegration(integration: typeof integrations.$inferSelect) {
    return {
      id: integration.id,
      name: integration.name,
      adapter: integration.adapter,
      status: integration.status,
      createdAt: integration.createdAt,
      updatedAt: integration.updatedAt,
      credentials: publicIntegrationCredentials(integration.verification),
      setup: integrationSetup(this.config.runtimeServiceUrl, integration.id, integration.adapter),
    };
  }

  private async advanceIntegrationDesiredState(
    tx: Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0],
    input: {
      integrationId: string;
      actorId: string;
      auditKind: string;
      auditDetail: Record<string, unknown>;
    },
  ): Promise<number> {
    const [state] = await tx.update(controllerState)
      .set({ desiredGeneration: sql`${controllerState.desiredGeneration} + 1`, updatedAt: new Date() })
      .where(eq(controllerState.id, "singleton")).returning();
    if (!state) throw new Error("Controller state is not initialized.");
    await tx.insert(auditEvents).values({
      id: randomUUID(),
      kind: input.auditKind,
      actorId: input.actorId,
      resourceType: "integration",
      resourceId: input.integrationId,
      detail: { ...input.auditDetail, generation: state.desiredGeneration },
    });
    await tx.insert(outboxEvents).values({
      id: randomUUID(),
      kind: "runner.desired_state_changed",
      aggregateId: input.integrationId,
      payload: {
        resourceType: "integration",
        resourceId: input.integrationId,
        generation: state.desiredGeneration,
        change: input.auditKind,
      },
    });
    return state.desiredGeneration;
  }

  private async mutateDeployment(
    id: string,
    actorId: string,
    auditKind: string,
    mutation: (
      tx: Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0],
      current: typeof deployments.$inferSelect,
    ) => Promise<typeof deployments.$inferSelect>,
  ) {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(deployments)
        .where(and(eq(deployments.id, id), isNull(deployments.deletedAt))).for("update");
      if (!current) throw new NotFoundError("Deployment", id);
      if (current.id === DEFAULT_DEPLOYMENT_ID) {
        throw new ValidationError("The Default Deployment is system managed and cannot be changed directly.");
      }
      const updated = await mutation(tx, current);
      await this.advanceDeploymentDesiredState(tx, id, actorId, auditKind, {
        integrationId: current.integrationId,
        guardrailId: current.guardrailId,
      });
      return updated;
    });
  }

  private async advanceDeploymentDesiredState(
    tx: Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0],
    aggregateId: string,
    actorId: string,
    auditKind: string,
    detail: Record<string, unknown>,
  ): Promise<number> {
    const [state] = await tx.update(controllerState)
      .set({ desiredGeneration: sql`${controllerState.desiredGeneration} + 1`, updatedAt: new Date() })
      .where(eq(controllerState.id, "singleton")).returning();
    if (!state) throw new Error("Controller state is not initialized.");
    await tx.insert(auditEvents).values({
      id: randomUUID(), kind: auditKind, actorId,
      resourceType: "deployment", resourceId: aggregateId,
      detail: { ...detail, generation: state.desiredGeneration },
    });
    await tx.insert(outboxEvents).values({
      id: randomUUID(), kind: "runner.desired_state_changed", aggregateId,
      payload: { resourceType: "deployment", resourceId: aggregateId, generation: state.desiredGeneration, change: auditKind },
    });
    return state.desiredGeneration;
  }

  private async deletionImpact(kind: "guardrail" | "integration" | "deployment", id: string, deploymentPoolIds: readonly string[]): Promise<DeletionImpact> {
    const cutoff = new Date(Date.now() - this.config.deletionTrafficWindowMinutes * 60_000);
    const condition = kind === "guardrail"
      ? eq(runtimeEvents.guardrailId, id)
      : kind === "integration"
        ? eq(runtimeEvents.integrationId, id)
        : eq(runtimeEvents.deploymentId, id);
    const [traffic] = await this.db.select({ requestCount: count(), lastRequestAt: max(runtimeEvents.occurredAt) })
      .from(runtimeEvents).where(and(condition, eq(runtimeEvents.direction, "incoming"), gte(runtimeEvents.occurredAt, cutoff)));
    const activeDeploymentCount = deploymentPoolIds.length;
    const uniquePoolIds = [...new Set(deploymentPoolIds)];
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
    const telemetryFresh = activeDeploymentCount === 0 || (
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
      activeDeploymentCount,
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
    resourceType: "guardrail" | "integration",
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
      "An Integration can have only one catch-all Deployment.",
      "deployment_catch_all_conflict",
    );
  }
  if (catchAllIndexes.length === 1 && catchAllIndexes[0] !== ordered.length - 1) {
    throw new ConflictError(
      "The catch-all Deployment must be the final route for its Integration.",
      "deployment_catch_all_order_conflict",
    );
  }
}

function programmablePolicyPayload(
  record: typeof policyRecords.$inferSelect,
  versions: Array<typeof policyVersions.$inferSelect>,
) {
  const rules = record.draft.rail_bindings.map((binding) => ({
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
  const railTypes = [...new Set(record.draft.rail_bindings.map((item) => item.rail_type))].sort();
  const effects = [...new Set(record.draft.rail_bindings.map((item) => item.on_unsafe))].sort();
  const testCases = record.draft.test_cases.map((item, index) => ({
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
  const outputDelivery = Object.fromEntries(record.draft.execution_contract).output_delivery;
  return {
    implementation: "nemo_native" as const,
    id: record.id,
    name: record.name,
    description: record.description,
    source: "custom" as const,
    version: String(versions.reduce((latest, item) => Math.max(latest, item.version), 0)),
    draft_revision: record.draftRevision,
    owner: record.owner,
    updated_at: record.updatedAt.toISOString(),
    tags: [
      { id: `implementation:colang-${record.draft.colang_version}`, namespace: "implementation", value: `colang-${record.draft.colang_version}`, label: `Colang ${record.draft.colang_version}`, source: "derived" as const },
      ...railTypes.map((railType) => ({
        id: `rail:${railType}`,
        namespace: "rail" as const,
        value: railType,
        label: `${railType[0]!.toUpperCase()}${railType.slice(1)} rail`,
        source: "derived" as const,
      })),
    ],
    parameters: record.draft.parameter_schema,
    rails: railTypes,
    effects,
    forms: ["colang_flow" as const],
    rules,
    test_cases: testCases,
    test_count: testCases.length,
    safety_level: "balanced" as const,
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
  description: string,
  revision: number,
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
    guardrail_version: revision,
    compiler_version: "tasklattice-controller-plan-v3",
    safety_level: "balanced",
    output_delivery: contract.output_delivery ?? "window_buffered",
    purpose: description || `Evaluate ${policyName}.`,
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

export function integrationSetup(runtimeServiceUrl: string, integrationId: string, adapter: string) {
  const apiBaseUrl = `${runtimeServiceUrl}/runtime/v1/integrations/${encodeURIComponent(integrationId)}`;
  const isLiteLLM = adapter === "litellm-generic-guardrail";
  const callbackUrl = isLiteLLM
    ? `${apiBaseUrl}/beta/litellm_basic_guardrail_api`
    : `${apiBaseUrl}/guardrails/evaluate`;
  const recommendedModes = isLiteLLM
    ? ["pre_call", "post_call"]
    : ["input", "output"];
  const yamlTemplate = isLiteLLM
    ? [
        "litellm_settings:",
        "  guardrails:",
        "    - guardrail_name: tasklattice-guard",
        "      litellm_params:",
        "        guardrail: tasklattice_guard",
        "        mode: [pre_call, post_call]",
        "        api_base: os.environ/TASKLATTICE_GUARD_API_BASE",
        "        api_key: os.environ/TASKLATTICE_GUARD_API_KEY",
        "        default_on: true",
        "        fail_on_error: true",
        "        unreachable_fallback: fail_closed",
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
