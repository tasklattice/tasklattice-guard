import { callFailureEvents, runtimeLogSource } from "./runtime-log-source.js";
import { advancesValidationProgress, type ValidationProgress } from "../../shared/validation-progress.js";
import { queryAuditEvents } from "./audit-events.js";
import type { AuditQuery } from "../../shared/audit-query.js";
import type { EventSeverity } from "../../shared/security-severity.js";
import { readGuardrailProfiles } from "./guardrail-profiles.js";
import { expandProtectionPreset } from "../policy-catalog/presets.js";
import { TrafficRoutingService } from "./traffic-routing.js";
import { GuardrailPackageService } from "./guardrail-packages.js";
import type { ArtifactAdmission } from "../domain/environment-check.js";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../../shared/canonical-json.js";
import { artifactContent, artifactContentDigest, ARTIFACT_CONTENT_DIGEST_VERSION, signArtifactDigest, type ArtifactContent } from "../domain/artifact-content.js";
import { canonicalArtifactContent } from "../control-channel/artifact-codec.js";
import { programmablePolicyProtection } from "../policy-studio/protection.js";
import { queryRuntimeMetrics, type MetricScope } from "./runtime-metrics.js";
import { boundedRead } from '../db/read-budget.js';
import { asText, findingSeverity, securityFinding, increment, jsonAggregate, jsonArrayLength, jsonElements, jsonObject, jsonText, jsonValue, literal, lowerText, rowValue, scalar, timestampValue } from '../db/postgres-expressions.js';
import { advisoryTransactionLock } from '../db/postgres-locks.js';

import { and, asc, count, countDistinct, desc, eq, exists, getTableColumns, gt, gte, inArray, isNotNull, isNull, lt, lte, max, min, ne, or, sql, type SQL } from "drizzle-orm";

import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { planToWire } from "../control-channel/protocol-codec.js";
import { describeDraftChanges, draftConfigContent, sameDraftContent, stableDraftValue, type DraftSnapshot } from "../domain/guardrail-draft-changes.js";
import type { GuardrailDraftChanges } from "../../shared/guardrail-draft-changes.js";
import {
  artifacts,
  auditEvents,
  controllerState,
  guardrails,
  guardrailVersionProvenance,
  guardrailVersions,
  trafficRouters,
  trafficRouterChangeRequests,
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
  DEFAULT_GUARDRAIL_ID,
  DEFAULT_GUARDRAIL_NAME,
  defaultGuardrailDraft,
} from "../domain/defaults.js";
import { ConflictError, ControllerError, NotFoundError, ValidationError } from "../domain/errors.js";
import { buildGuardrailPlan, normalizeGuardrailDraft, type GuardrailDraftConfig } from "../domain/guardrail-plan.js";
import type { DeletionImpact, RuntimeEventInput, ValidationCaseResult, ValidationMetrics, ValidationRuntimeFingerprint } from "../domain/models.js";
import { guardrailInspection } from "../domain/guardrail-inspection.js";
import { freezeTestSuite, testSuiteDigest } from "../domain/test-suite.js";
import { aggregateReleasedPolicies } from "../domain/released-policies.js";
import { applyValidationOverrides, emptyValidationMetrics, generatedTestCases } from "../domain/validation.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { customPolicyCompliance } from "../policy-catalog/compliance.js";
import { registeredAction } from "../action-catalog/catalog.js";
import type { ValidationTerminalState } from "../../shared/lifecycle.js";
import { guardrailCategoryLabels } from "../../shared/guardrail-catalog.js";
import { guardrailVersionId } from "../../shared/guardrail-version.js";
import type { GuardrailVersionDeletionBlocker, GuardrailVersionDeletionImpact, GuardrailVersionReference } from "../../shared/guardrail-version-deletion.js";

type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];
import {
  flowRule,
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
  readonly packages: GuardrailPackageService;
  private catalog: PolicyCatalog | null = null;
  private readonly runtimeLogEncryptionKey: Buffer | null;

  constructor(
    private readonly db: ControllerDatabase,
    private readonly config: ControllerConfig,
  ) {
    this.trafficRouting = new TrafficRoutingService(db);
    this.packages = new GuardrailPackageService(db, config);
    this.runtimeLogEncryptionKey = decodeRuntimeLogKey(config.runtimeLogEncryptionKey);
  }

  /** Runner load checks for environment readiness (wired by the control channel). */
  setArtifactAdmission(admission: ArtifactAdmission): void {
    this.packages.setArtifactAdmission(admission);
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
      // A receiving environment never builds the Default from a Library: its
      // runtime baseline arrives as a released version and is set explicitly.
      await this.ensureDefaultGuardrail(tx);
    });
  }

  /**
   * The Default Guardrail version every pool serves as basic protection. It is
   * always a pinned version, set explicitly (or by the very first Default
   * publication); publishing another Default version never moves it.
   */
  private async baselineVersion(db: Pick<ControllerDatabase, "select"> = this.db): Promise<string | null> {
    const [state] = await db.select({ baselineVersion: controllerState.baselineVersion }).from(controllerState).where(eq(controllerState.id, "singleton")).limit(1);
    return state?.baselineVersion ?? null;
  }

  /**
   * The version a working draft is compared with: the one most recently
   * published from it. It only answers "what changed since publishing"; no
   * Router, baseline or export ever follows it.
   */
  private async lastPublishedVersion(db: Pick<ControllerDatabase, "select">, guardrailId: string) {
    const [row] = await db.select().from(guardrailVersions).where(and(
      eq(guardrailVersions.guardrailId, guardrailId), eq(guardrailVersions.status, "ready"), eq(guardrailVersions.origin, "local"),
    )).orderBy(desc(guardrailVersions.createdAt), desc(guardrailVersions.version)).limit(1);
    return row ?? null;
  }

  async systemBaseline() {
    return { guardrailId: DEFAULT_GUARDRAIL_ID, version: await this.baselineVersion() };
  }

  /**
   * Switch the runtime baseline to a ready Default version: an explicit,
   * audited change, never a side effect of importing or marking Latest.
   */
  async setSystemBaseline(input: { version: string; reason: string; actorId: string }) {
    // An imported version must first prove Runners here can load it.
    const [target] = await this.db.select({ origin: guardrailVersions.origin }).from(guardrailVersions)
      .where(and(eq(guardrailVersions.guardrailId, DEFAULT_GUARDRAIL_ID), eq(guardrailVersions.version, input.version)));
    if (target?.origin === "imported") await this.packages.checkVersionEnvironment(DEFAULT_GUARDRAIL_ID, input.version).catch(() => undefined);
    return this.db.transaction(async tx => {
      const [version] = await tx.select().from(guardrailVersions)
        .innerJoin(guardrails, eq(guardrails.id, guardrailVersions.guardrailId))
        .where(and(eq(guardrailVersions.guardrailId, DEFAULT_GUARDRAIL_ID), eq(guardrailVersions.version, input.version), isNull(guardrails.deletedAt)));
      if (!version || version.guardrail_version.status !== "ready" || !version.guardrail_version.artifactId) {
        throw new ConflictError(`Default Guardrail version ${input.version} is not a ready version.`, "baseline_version_not_ready");
      }
      const check = version.guardrail_version.environmentCheck;
      if (version.guardrail_version.origin === "imported" && check?.status !== "compatible") {
        throw new ConflictError("This environment has not confirmed it can serve this version. Resolve the missing dependencies and try again.",
          "guardrail_version_environment_unverified", { environment: check ?? null });
      }
      const previous = await this.baselineVersion(tx);
      if (previous === input.version) return this.systemBaselineIn(tx);
      const [state] = await tx.update(controllerState).set({
        baselineVersion: input.version, desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date(),
      }).where(eq(controllerState.id, "singleton")).returning();
      if (!state) throw new Error("Controller state is not initialized.");
      await tx.insert(outboxEvents).values({
        id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: DEFAULT_GUARDRAIL_ID,
        payload: { guardrailId: DEFAULT_GUARDRAIL_ID, version: input.version, generation: state.desiredGeneration, baseline: true },
      });
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "system.baseline_changed", actorId: input.actorId, resourceType: "guardrail", resourceId: DEFAULT_GUARDRAIL_ID,
        detail: { previousVersion: previous, version: input.version, reason: input.reason, generation: state.desiredGeneration },
      });
      return this.systemBaselineIn(tx);
    });
  }

  /**
   * Import a deployment-supplied Default Guardrail package at startup and,
   * when no baseline is set yet, adopt the one version it carries. Idempotent.
   */
  async importBaselinePackage(bytes: Buffer): Promise<{ version: string; adopted: boolean }> {
    const preview = await this.packages.inspectUpload(bytes, null);
    if (preview.guardrail.id !== DEFAULT_GUARDRAIL_ID) throw new ConflictError("The baseline package must contain the Default Guardrail.", "baseline_package_invalid");
    if (preview.blockers.length) throw new ConflictError(preview.blockers.map(item => item.message).join(" "), preview.blockers[0]!.code);
    // The baseline is a pinned version, so the package must name exactly one.
    if (preview.versions.length !== 1) throw new ConflictError("The baseline package must contain exactly one Default Guardrail version.", "baseline_package_invalid");
    const baseline = preview.versions[0]!.version;
    await this.packages.importPackage(preview.packageId, { actorId: null });
    return this.db.transaction(async tx => {
      const [state] = await tx.select().from(controllerState).where(eq(controllerState.id, "singleton")).for("update");
      if (state?.baselineVersion) return { version: state.baselineVersion, adopted: false };
      const [updated] = await tx.update(controllerState).set({
        baselineVersion: baseline, desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date(),
      }).where(eq(controllerState.id, "singleton")).returning();
      await tx.insert(outboxEvents).values({
        id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: DEFAULT_GUARDRAIL_ID,
        payload: { guardrailId: DEFAULT_GUARDRAIL_ID, version: baseline, generation: updated?.desiredGeneration ?? 0, baseline: true },
      });
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "system.baseline_changed", actorId: null, resourceType: "guardrail", resourceId: DEFAULT_GUARDRAIL_ID,
        detail: { previousVersion: null, version: baseline, reason: "Deployment baseline package", packageId: preview.packageId },
      });
      return { version: baseline, adopted: true };
    });
  }

  private async systemBaselineIn(tx: Transaction) {
    return { guardrailId: DEFAULT_GUARDRAIL_ID, version: await this.baselineVersion(tx) };
  }

  /**
   * Re-seal Artifacts signed under an earlier digest contract. Content is
   * normalized through the transport schema, so stored JSON, checksum and the
   * Runner's recomputed digest agree byte for byte afterwards.
   */
  async resealArtifacts(): Promise<number> {
    return this.db.transaction(async (tx) => {
      await advisoryTransactionLock(tx, 'tasklattice-guard-product-defaults');
      return this.resealStaleArtifacts(tx);
    });
  }

  private async resealStaleArtifacts(tx: Transaction): Promise<number> {
    const stale = await tx.select().from(artifacts)
      .where(ne(artifacts.contentDigestVersion, ARTIFACT_CONTENT_DIGEST_VERSION)).for("update");
    if (!stale.length) return 0;
    const referenced = new Set((await tx.select({ artifactId: guardrailVersions.artifactId }).from(guardrailVersions)
      .where(inArray(guardrailVersions.artifactId, stale.map(row => row.id)))).map(row => row.artifactId));
    const sealed = stale.map(row => {
      const content = canonicalArtifactContent(row as ArtifactContent, this.config.protoPath);
      return { row, content, checksum: artifactContentDigest(content) };
    });
    const byChecksum = new Map<string, typeof sealed>();
    for (const item of sealed) byChecksum.set(item.checksum, [...byChecksum.get(item.checksum) ?? [], item]);
    for (const [checksum, group] of byChecksum) {
      // Rows that differed only by their delivery generation now share content.
      const kept = group.filter(item => referenced.has(item.row.id));
      if (kept.length > 1) throw new Error(`Artifacts ${kept.map(item => item.row.id).join(", ")} share content ${checksum}; remove the duplicate version before upgrading.`);
      const [keep = group[0]!, ...rest] = [...kept, ...group.filter(item => !referenced.has(item.row.id))];
      if (rest.length) await tx.delete(artifacts).where(inArray(artifacts.id, rest.map(item => item.row.id)));
      await tx.update(artifacts).set({
        ...keep.content,
        checksum,
        signature: signArtifactDigest(checksum, this.config.artifactSigningKeyPath),
        contentDigestVersion: ARTIFACT_CONTENT_DIGEST_VERSION,
      }).where(eq(artifacts.id, keep.row.id));
    }
    const [state] = await tx.update(controllerState).set({
      desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date(),
    }).where(eq(controllerState.id, "singleton")).returning();
    await tx.insert(outboxEvents).values({
      id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: "artifact-reseal",
      payload: { generation: state?.desiredGeneration ?? 0, resealed: sealed.length },
    });
    await tx.insert(auditEvents).values({
      id: randomUUID(), kind: "artifact.resealed", actorId: null, resourceType: "artifact", resourceId: "all",
      detail: { count: sealed.length, digestVersion: ARTIFACT_CONTENT_DIGEST_VERSION },
    });
    return sealed.length;
  }

  async desiredGeneration(): Promise<number> {
    const [state] = await this.db.select().from(controllerState).where(eq(controllerState.id, "singleton"));
    return state?.desiredGeneration ?? 0;
  }

  async listGuardrailProfiles() {
    const profiles = await readGuardrailProfiles(this.db);
    const policies = await this.listPolicies();
    return profiles.map(profile => ({ ...profile, policyBindings: expandProtectionPreset(profile, policies) }));
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
      const runId = `policy-testing-report-${randomUUID()}`;
      const candidateVersion = guardrailVersionId();
      const snapshot = policySnapshot(record, String(record.draftRevision), "");
      snapshot.checksum = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
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
      const checksum = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
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
    const [validation] = guardrail ? await this.db.select().from(validationRuns).where(and(
      eq(validationRuns.guardrailId, DEFAULT_GUARDRAIL_ID),
      eq(validationRuns.subject, "draft"),
      eq(validationRuns.sourceDraftRevision, guardrail.draftRevision),
    )).orderBy(desc(validationRuns.createdAt)).limit(1) : [];

    const baseline = guardrail ? await this.baselineVersion() : null;
    const [version] = baseline ? await this.db.select().from(guardrailVersions).where(and(
      eq(guardrailVersions.guardrailId, DEFAULT_GUARDRAIL_ID),
      eq(guardrailVersions.version, baseline),
    )).limit(1) : [];
    const [artifact] = version?.artifactId ? await this.db.select().from(artifacts)
      .where(eq(artifacts.id, version.artifactId)).limit(1) : [];
    const guardrailActive = Boolean(guardrail && guardrail.status !== "disabled"
      && version?.status === "ready" && version.artifactId === artifact?.id
      && artifact?.guardrailId === DEFAULT_GUARDRAIL_ID && artifact.guardrailVersion === baseline
      && artifact.checksum && artifact.signature);
    const coverage = guardrailActive ? publishedProtectionCoverage(artifact?.plan) : null;
    const hasChecks = Boolean(coverage && (coverage.inputChecks > 0 || coverage.outputChecks > 0));
    const preparing = guardrail?.status !== "disabled" && Boolean(validation?.status === "queued" || validation?.status === "running");
    const initializing = Boolean(guardrail && !guardrailActive && preparing);

    return {
      status: guardrailActive && hasChecks ? "ready" : initializing ? "initializing" : "unavailable",
      guardrailStatus: guardrailActive ? "active" as const : preparing ? "initializing" as const : "unavailable" as const,
      baselineVersion: baseline,
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

  /**
   * Policies frozen in this environment's ready Guardrail versions, grouped by
   * Policy ID. Read from version plans only, never from the Policy Library, so
   * a receiving environment shows exactly what it can run.
   */
  async releasedPolicies() {
    const rows = await this.db.select({
      guardrailId: guardrailVersions.guardrailId, guardrailVersion: guardrailVersions.version, plan: guardrailVersions.plan,
      origin: guardrailVersions.origin, guardrailName: guardrails.name, sourceId: guardrails.sourceId,
    }).from(guardrailVersions)
      .innerJoin(guardrails, and(eq(guardrails.id, guardrailVersions.guardrailId), isNull(guardrails.deletedAt)))
      .where(eq(guardrailVersions.status, "ready"));
    const routers = await this.db.select({ activeSnapshot: trafficRouters.activeSnapshot }).from(trafficRouters).where(isNull(trafficRouters.deletedAt));
    const serving = new Set(routers.flatMap(router => router.activeSnapshot?.routes.filter(route => route.enabled)
      .flatMap(route => route.targets.filter(target => target.weightBps > 0).map(target => `${target.guardrailId}\u0000${target.guardrailVersion}`)) ?? []));
    return { items: aggregateReleasedPolicies(rows.map(row => ({
      guardrailId: row.guardrailId, guardrailName: row.guardrailName, guardrailVersion: row.guardrailVersion,
      origin: row.origin, sourceId: row.sourceId,
      serving: serving.has(`${row.guardrailId}\u0000${row.guardrailVersion}`), plan: row.plan,
    }))) };
  }

  /** The Test Cases frozen into one version: part of its definition, read only. */
  async guardrailVersionTestSuite(guardrailId: string, version: string) {
    const [row] = await this.db.select({ testSuite: guardrailVersions.testSuite }).from(guardrailVersions)
      .innerJoin(guardrails, and(eq(guardrails.id, guardrailVersions.guardrailId), isNull(guardrails.deletedAt)))
      .where(and(eq(guardrailVersions.guardrailId, guardrailId), eq(guardrailVersions.version, version)));
    if (!row) throw new NotFoundError("Guardrail version", `${guardrailId}@${version}`);
    const items = row.testSuite ?? [];
    return { guardrailId, version, recorded: row.testSuite !== null, digest: row.testSuite ? testSuiteDigest(row.testSuite) : null, items, count: items.length };
  }

  async getGuardrail(id: string) {
    const [guardrail] = await this.db.select().from(guardrails).where(and(eq(guardrails.id, id), isNull(guardrails.deletedAt)));
    if (!guardrail) throw new NotFoundError("Guardrail", id);
    const versions = await this.db.select().from(guardrailVersions)
      .where(eq(guardrailVersions.guardrailId, id)).orderBy(desc(guardrailVersions.version));
    const artifactRows = await this.db.select().from(artifacts).where(eq(artifacts.guardrailId, id));
    const artifactsById = new Map(artifactRows.map((artifact) => [artifact.id, artifact]));
    const provenanceRows = await this.db.select().from(guardrailVersionProvenance).where(eq(guardrailVersionProvenance.guardrailId, id));
    return {
      ...await this.guardrailSummary(guardrail),
      // The test suite can be large; it has its own read (guardrailVersionTestSuite).
      versions: versions.map(({ sourceSnapshot, testSuite, ...version }) => {
        const provenance = provenanceRows.find(item => item.version === version.version);
        return {
          ...version,
          hasSourceSnapshot: Boolean(sourceSnapshot),
          testSuiteCount: testSuite?.length ?? null,
          artifact: version.artifactId ? artifactsById.get(version.artifactId) ?? null : null,
          provenance: provenance ? {
            sourceId: provenance.sourceId, sourceKeyId: provenance.sourceKeyId, contentDigest: provenance.contentDigest,
            packageId: provenance.packageId, importedAt: provenance.importedAt, importedBy: provenance.importedBy,
            requirements: provenance.requirements,
          } : null,
        };
      }),
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
      checksum: createHash("sha256").update(canonicalJson({ draftConfig, runtimeProfile: input.runtimeProfile })).digest("hex"),
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
      const requestDigest = createHash("sha256").update(canonicalJson({ id: input.id, name: input.name, sourceVersion: input.sourceVersion, sourceDraftRevision: input.sourceDraftRevision })).digest("hex");
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
        if (!sourceVersion) throw new ValidationError("Choose a source draft revision or a published Guardrail Version.");
        const [version] = await tx.select().from(guardrailVersions).where(and(eq(guardrailVersions.guardrailId, input.id), eq(guardrailVersions.version, sourceVersion)));
        if (!version?.sourceSnapshot) throw new ConflictError("This version has no complete source snapshot. Choose the current draft explicitly, or publish a new version before copying.", "source_snapshot_unavailable");
        snapshot = version.sourceSnapshot;
      }
      const copiedId = randomUUID();
      const copyOrigin = { sourceGuardrailId: input.id, sourceName: source.name, sourceVersion: sourceVersion ?? null, sourceDraftRevision: input.sourceDraftRevision ?? null, copiedAt: new Date().toISOString(), contentDigest: createHash("sha256").update(canonicalJson(snapshot)).digest("hex"), requestDigest };
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
    expectedDraftRevision?: number | undefined;
  }) {
    const updated = await this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(guardrails).where(and(
        eq(guardrails.id, input.id), isNull(guardrails.deletedAt),
      )).for("update");
      if (!existing) throw new NotFoundError("Guardrail", input.id);
      if (input.expectedDraftRevision !== undefined && input.expectedDraftRevision !== existing.draftRevision) {
        throw new ConflictError("The draft changed while you were editing. Reload and review the latest changes before saving.", "guardrail_draft_conflict");
      }
      const draftConfig = input.draftConfig ? normalizeGuardrailDraft(input.draftConfig) : normalizeGuardrailDraft(existing.draftConfig);
      await this.validateGuardrailDraft(draftConfig);
      // Runtime profile affects compilation just as a Policy edit does. A
      // validation for the old profile cannot authorize a new executable.
      const draftChanged = stableDraftValue(draftConfigContent(draftConfig)) !== stableDraftValue(draftConfigContent(existing.draftConfig))
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

  async guardrailDraftChanges(id: string): Promise<GuardrailDraftChanges> {
    return this.db.transaction(async tx => {
      const [guardrail] = await tx.select().from(guardrails).where(and(eq(guardrails.id, id), isNull(guardrails.deletedAt))).for("share");
      if (!guardrail) throw new NotFoundError("Guardrail", id);
      const baseline = await this.lastPublishedVersion(tx, id);
      const cases = await tx.select().from(testCases).where(eq(testCases.guardrailId, id));
      const current: DraftSnapshot = { draftConfig: guardrail.draftConfig, runtimeProfile: guardrail.runtimeProfile,
        loggingLevel: guardrail.loggingLevel, excludedTestCaseIds: guardrail.excludedTestCaseIds, testCases: cases };
      const snapshot = baseline?.sourceSnapshot;
      const complete = Boolean(snapshot?.testCases);
      const hasUnpublishedChanges = snapshot && complete ? !sameDraftContent(snapshot, current)
        : !baseline || baseline.sourceDraftRevision !== guardrail.draftRevision;
      return { draftRevision: guardrail.draftRevision, baselineVersion: baseline?.version ?? null,
        baselineAvailable: !baseline || complete, hasUnpublishedChanges,
        canDiscard: hasUnpublishedChanges && complete && baseline?.status === "ready",
        changes: hasUnpublishedChanges && (!baseline || complete) ? describeDraftChanges(snapshot ?? null, current) : [],
      };
    });
  }

  async discardGuardrailDraft(input: { id: string; actorId: string; expectedDraftRevision: number; expectedBaselineVersion: string }) {
    const restored = await this.db.transaction(async tx => {
      const [guardrail] = await tx.select().from(guardrails).where(and(eq(guardrails.id, input.id), isNull(guardrails.deletedAt))).for("update");
      if (!guardrail) throw new NotFoundError("Guardrail", input.id);
      if (guardrail.draftRevision !== input.expectedDraftRevision || (await this.lastPublishedVersion(tx, input.id))?.version !== input.expectedBaselineVersion) {
        throw new ConflictError("The draft or published baseline changed. Review the changes again before discarding.", "guardrail_draft_conflict");
      }
      const [baseline] = await tx.select().from(guardrailVersions).where(and(eq(guardrailVersions.guardrailId, input.id), eq(guardrailVersions.version, input.expectedBaselineVersion)));
      const snapshot = baseline?.sourceSnapshot;
      if (baseline?.status !== "ready" || !snapshot?.testCases) throw new ConflictError("This version has no complete source snapshot to restore.", "source_snapshot_unavailable");
      const currentCases = await tx.select().from(testCases).where(eq(testCases.guardrailId, input.id));
      if (sameDraftContent(snapshot, { draftConfig: guardrail.draftConfig, runtimeProfile: guardrail.runtimeProfile,
        loggingLevel: guardrail.loggingLevel, excludedTestCaseIds: guardrail.excludedTestCaseIds, testCases: currentCases })) return guardrail;
      await tx.delete(testCases).where(eq(testCases.guardrailId, input.id));
      if (snapshot.testCases.length) await tx.insert(testCases).values(snapshot.testCases.map(item => ({ ...item, guardrailId: input.id, updatedAt: new Date() })));
      const [updated] = await tx.update(guardrails).set({ draftConfig: snapshot.draftConfig, runtimeProfile: snapshot.runtimeProfile,
        excludedTestCaseIds: snapshot.excludedTestCaseIds, draftRevision: increment(guardrails.draftRevision), updatedAt: new Date(),
      }).where(eq(guardrails.id, input.id)).returning();
      await tx.insert(auditEvents).values({ id: randomUUID(), kind: "guardrail.draft_discarded", actorId: input.actorId,
        resourceType: "guardrail", resourceId: input.id, detail: { previousDraftRevision: guardrail.draftRevision, baselineVersion: baseline.version },
      });
      return updated!;
    });
    return this.guardrailSummary(restored);
  }

  async requestGuardrailPublish(input: {
    guardrailId: string;
    actorId: string;
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
        eq(validationRuns.subject, "draft"),
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
      const version = latestValidation.guardrailVersion;
      const [existingVersion] = await tx.select().from(guardrailVersions).where(and(
        eq(guardrailVersions.guardrailId, input.guardrailId),
        eq(guardrailVersions.version, version),
      )).limit(1);
      if (existingVersion) {
        await tx.update(validationRuns).set({ guardrailVersion: existingVersion.version })
          .where(eq(validationRuns.id, latestValidation.id));
        // Publishing the same tested content again is a no-op: that version exists.
        return {
          compileId: null,
          guardrailId: input.guardrailId,
          version: existingVersion.version,
          generation: existingVersion.generation,
          status: existingVersion.status,
        };
      }
      await tx.update(validationRuns).set({ guardrailVersion: version })
        .where(eq(validationRuns.id, latestValidation.id));
      return this.publishValidatedCandidate(tx, guardrail, latestValidation, input.actorId);
    });
  }

  async guardrailVersionDeletionImpact(guardrailId: string, version: string) {
    return this.db.transaction(async tx => {
      const { guardrail, record } = await this.loadGuardrailVersion(tx, guardrailId, version);
      return this.versionDeletionImpact(tx, guardrail, record);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  /** A version can be deleted once nothing routes to it, it is not Latest, and Runners have stopped serving it. */
  async deleteGuardrailVersion(input: { guardrailId: string; version: string; actorId: string }) {
    await this.db.transaction(async tx => {
      // Same lock ordering as composed Router publication: bindings, then resource.
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const { guardrail, record } = await this.loadGuardrailVersion(tx, input.guardrailId, input.version, true);
      const impact = await this.versionDeletionImpact(tx, guardrail, record);
      if (!impact.deletable) {
        const reason = impact.references.length ? "This version is still referenced. Remove the references first." : "This version cannot be deleted yet. Try again after it stops serving traffic.";
        throw new ConflictError(reason, "version_in_use", { impact });
      }
      await tx.insert(auditEvents).values({ id: randomUUID(), kind: "guardrail.version_deleted", actorId: input.actorId, resourceType: "guardrail", resourceId: input.guardrailId,
        detail: { version: input.version, artifactId: record.artifactId, unrestorableRevisions: impact.unrestorableRevisions } });
      // Keep artifacts and telemetry: deleting a version must not purge evidence.
      await tx.delete(guardrailVersions).where(and(eq(guardrailVersions.guardrailId, input.guardrailId), eq(guardrailVersions.version, input.version)));
    });
  }

  private async loadGuardrailVersion(tx: Transaction, guardrailId: string, version: string, lock = false) {
    const query = tx.select().from(guardrails).where(and(eq(guardrails.id, guardrailId), isNull(guardrails.deletedAt)));
    const [guardrail] = lock ? await query.for("update") : await query;
    if (!guardrail) throw new NotFoundError("Guardrail", guardrailId);
    const [record] = await tx.select().from(guardrailVersions).where(and(eq(guardrailVersions.guardrailId, guardrailId), eq(guardrailVersions.version, version)));
    if (!record) throw new NotFoundError("Guardrail version", version);
    return { guardrail, record };
  }

  private async versionDeletionImpact(tx: Transaction, guardrail: typeof guardrails.$inferSelect, record: typeof guardrailVersions.$inferSelect): Promise<GuardrailVersionDeletionImpact> {
    const routing = await this.trafficRouting.versionReferences(guardrail.id, record.version, tx);
    // The runtime baseline is pinned like a Router target and protects its version the same way.
    const baseline = guardrail.id === DEFAULT_GUARDRAIL_ID && await this.baselineVersion(tx) === record.version;
    const references: GuardrailVersionReference[] = [...(baseline ? [{ kind: "baseline" as const }] : []), ...routing.references];
    const blockers: GuardrailVersionDeletionBlocker[] = [];
    const retention = 300_000;
    const [call] = await tx.select({ id: routeAssignments.decisionId }).from(routeAssignments).where(and(eq(routeAssignments.guardrailId, guardrail.id),
      eq(routeAssignments.guardrailVersion, record.version), isNull(routeAssignments.completedAt), gte(routeAssignments.occurredAt, new Date(Date.now() - retention)))).limit(1);
    if (call) blockers.push({ code: "in_flight_calls" });
    if (routing.retired) {
      // Calls that started before the version left routing may still be running.
      const until = routing.retired.at.getTime() + retention;
      if (until > Date.now()) blockers.push({ code: "recently_served", until: new Date(until).toISOString() });
      const generation = routing.retired.generation;
      if (generation !== null) {
        const runners = await tx.select().from(runnerInstances).where(eq(runnerInstances.poolId, "default"));
        const online = runners.filter(r => r.lastHeartbeatAt && Date.now() - r.lastHeartbeatAt.getTime() < 60_000);
        if (online.some(r => r.appliedGeneration < generation)) blockers.push({ code: "runner_sync" });
      }
    }
    return { guardrailId: guardrail.id, version: record.version, deletable: !references.length && !blockers.length, references, blockers, unrestorableRevisions: routing.historical };
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
      const [guardrail] = await tx.select().from(guardrails).where(and(eq(guardrails.id, input.guardrailId), isNull(guardrails.deletedAt))).for("update");
      if (!guardrail) throw new NotFoundError("Guardrail", input.guardrailId);
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
      if (excluded.has(input.caseId) === input.excluded) return item;
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
    const rows = await (guardrailId
      ? query.where(eq(validationRuns.guardrailId, guardrailId)).orderBy(desc(validationRuns.createdAt))
      : query.orderBy(desc(validationRuns.createdAt)));
    return rows.map(publicValidationRun);
  }

  async getValidationRun(id: string) {
    const [run] = await this.db.select().from(validationRuns).where(eq(validationRuns.id, id));
    if (!run) throw new NotFoundError("Validation Run", id);
    return publicValidationRun(run);
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

  /**
   * Test an existing version in this environment: its own frozen suite against
   * its signed Artifact, as it is. Nothing is compiled; the run records which
   * content and which suite it tested, so a release can rely on it.
   */
  async requestVersionTestRun(input: { guardrailId: string; version: string; actorId: string }) {
    return this.db.transaction(async tx => {
      const [guardrail] = await tx.select().from(guardrails).where(and(eq(guardrails.id, input.guardrailId), isNull(guardrails.deletedAt)));
      if (!guardrail) throw new NotFoundError("Guardrail", input.guardrailId);
      const [version] = await tx.select().from(guardrailVersions).where(and(
        eq(guardrailVersions.guardrailId, input.guardrailId), eq(guardrailVersions.version, input.version)));
      if (!version) throw new NotFoundError("Guardrail version", `${input.guardrailId}@${input.version}`);
      const [artifact] = version.artifactId ? await tx.select().from(artifacts).where(eq(artifacts.id, version.artifactId)) : [];
      if (!artifact) throw new ConflictError("This version has no Artifact to test.", "guardrail_version_artifact_missing");
      if (!version.testSuite?.length) {
        throw new ConflictError("This version carries no test suite. Publish it again to record one.", "guardrail_version_test_suite_missing");
      }
      const running = await tx.select({ id: validationRuns.id }).from(validationRuns).where(and(
        eq(validationRuns.guardrailId, input.guardrailId), eq(validationRuns.guardrailVersion, input.version),
        eq(validationRuns.subject, "version"), inArray(validationRuns.status, ["queued", "running"]))).limit(1);
      if (running.length) throw new ConflictError("This version is already being tested.", "guardrail_version_test_running", { runId: running[0]!.id });
      const runId = `testing-report-${randomUUID()}`;
      await tx.insert(validationRuns).values({
        id: runId, guardrailId: input.guardrailId, guardrailVersion: input.version, sourceDraftRevision: version.sourceDraftRevision,
        subject: "version", status: "queued", metrics: emptyValidationMetrics(version.testSuite.length), results: [], excludedCaseIds: [],
        // The content and suite under test; a release checks both against the version.
        candidateDigest: artifact.checksum, candidateInspection: version.inspection, testSuite: version.testSuite,
        testSuiteDigest: testSuiteDigest(version.testSuite), createdBy: input.actorId,
      });
      await tx.insert(outboxEvents).values({
        id: runId, kind: "guardrail.validation_requested", aggregateId: input.guardrailId,
        payload: {
          runId, guardrailId: input.guardrailId, candidateVersion: input.version, sourceDraftRevision: version.sourceDraftRevision,
          runtimeProfile: version.runtimeProfile, testCases: version.testSuite, artifact,
        },
      });
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.version_test_requested", actorId: input.actorId,
        resourceType: "guardrail", resourceId: input.guardrailId,
        detail: { runId, version: input.version, contentDigest: artifact.checksum, testCaseCount: version.testSuite.length },
      });
      return publicValidationRun((await tx.select().from(validationRuns).where(eq(validationRuns.id, runId)))[0]!);
    });
  }

  /**
   * Release a pending version in this environment. It must have passed its
   * own test suite here, against exactly this content: the most recent
   * completed test of the version passed, and tested this Artifact digest
   * and this suite. That run is bound to the version for good. Releasing
   * changes no Router or baseline; it only makes the version usable.
   */
  async releaseGuardrailVersion(input: { guardrailId: string; version: string; actorId: string }) {
    return this.db.transaction(async tx => {
      const [guardrail] = await tx.select().from(guardrails).where(and(eq(guardrails.id, input.guardrailId), isNull(guardrails.deletedAt))).for("update");
      if (!guardrail) throw new NotFoundError("Guardrail", input.guardrailId);
      const [version] = await tx.select().from(guardrailVersions).where(and(
        eq(guardrailVersions.guardrailId, input.guardrailId), eq(guardrailVersions.version, input.version))).for("update");
      if (!version) throw new NotFoundError("Guardrail version", `${input.guardrailId}@${input.version}`);
      if (version.status === "ready") return version;
      const [artifact] = version.artifactId ? await tx.select().from(artifacts).where(eq(artifacts.id, version.artifactId)) : [];
      const [run] = await tx.select().from(validationRuns).where(and(
        eq(validationRuns.guardrailId, input.guardrailId), eq(validationRuns.guardrailVersion, input.version),
        eq(validationRuns.subject, "version"), inArray(validationRuns.status, ["passed", "failed"]),
      )).orderBy(desc(validationRuns.completedAt)).limit(1);
      const suiteDigest = version.testSuite ? testSuiteDigest(version.testSuite) : null;
      if (!artifact || !run || run.status !== "passed" || run.candidateDigest !== artifact.checksum || run.testSuiteDigest !== suiteDigest) {
        throw new ConflictError(
          "Release requires a passed test of this exact version in this environment. Run its test suite and release after it passes.",
          "guardrail_version_test_required",
          { version: input.version, lastRun: run ? { id: run.id, status: run.status } : null },
        );
      }
      const [state] = await tx.update(controllerState).set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton")).returning();
      if (!state) throw new Error("Controller state is not initialized.");
      const [released] = await tx.update(guardrailVersions).set({ status: "ready", validationRunId: run.id, releasedAt: new Date(), releasedBy: input.actorId })
        .where(and(eq(guardrailVersions.guardrailId, input.guardrailId), eq(guardrailVersions.version, input.version))).returning();
      await tx.update(guardrails).set({ status: "active", updatedAt: new Date() })
        .where(and(eq(guardrails.id, input.guardrailId), eq(guardrails.status, "draft")));
      await tx.insert(outboxEvents).values({
        id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: input.guardrailId,
        payload: { guardrailId: input.guardrailId, version: input.version, generation: state.desiredGeneration, released: true },
      });
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.version_released", actorId: input.actorId, resourceType: "guardrail", resourceId: input.guardrailId,
        detail: { version: input.version, validationRunId: run.id, contentDigest: artifact.checksum, testSuiteDigest: suiteDigest, origin: version.origin },
      });
      return released!;
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
      // The run executes exactly this frozen suite; publishing copies it onto the version.
      const testSuite = freezeTestSuite(activeCases);
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
      const runId = `testing-report-${randomUUID()}`;
      const inspection = guardrailInspection({
        name: guardrail.name, runtimeProfile: guardrail.runtimeProfile, draftConfig: normalizeGuardrailDraft(guardrail.draftConfig),
        catalog: this.policyCatalog().list(), programmablePolicies, testSuite,
      });
      await tx.insert(validationRuns).values({
        id: runId,
        guardrailId: guardrail.id,
        guardrailVersion: candidateVersion,
        sourceDraftRevision: guardrail.draftRevision,
        status: "queued",
        metrics: emptyValidationMetrics(activeCases.length),
        results: [],
        excludedCaseIds: [...excluded],
        candidateInspection: inspection,
        testSuite,
        testSuiteDigest: inspection.testSuite.digest,
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
          testCases: testSuite,
        },
      });
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.validation_requested", actorId,
        resourceType: "guardrail", resourceId: guardrail.id,
        detail: { runId, sourceDraftRevision: guardrail.draftRevision, testCaseCount: activeCases.length },
      });
      return publicValidationRun((await tx.select().from(validationRuns).where(eq(validationRuns.id, runId)))[0]!);
  }

  async markValidationRunning(runId: string): Promise<void> {
    const policyUpdate = await this.db.update(policyValidationRuns).set({ status: "running" })
      .where(and(eq(policyValidationRuns.id, runId), eq(policyValidationRuns.status, "queued"))).returning({ id: policyValidationRuns.id });
    if (policyUpdate.length) return;
    await this.db.update(validationRuns).set({ status: "running" })
      .where(and(eq(validationRuns.id, runId), eq(validationRuns.status, "queued")));
  }

  async updateValidationProgress(runId: string, observation: Omit<ValidationProgress, "updatedAt">): Promise<void> {
    await this.db.transaction(async tx => {
      const [run] = await tx.select().from(validationRuns).where(eq(validationRuns.id, runId)).for("update");
      // Policy tests use their own report contract; old/finished runs ignore late observations.
      if (!run || (run.status !== "queued" && run.status !== "running")) return;
      const progress = { ...observation, updatedAt: new Date().toISOString() };
      if (!advancesValidationProgress(run.progress, progress, run.metrics.total)) return;
      await tx.update(validationRuns).set({ status: "running", progress }).where(eq(validationRuns.id, runId));
    });
  }

  async completeValidation(input: {
    runId: string;
    status: ValidationTerminalState;
    metrics: ValidationMetrics;
    results: ValidationCaseResult[];
    reason?: string | undefined;
    candidateArtifact?: ArtifactContent | undefined;
    runtime?: ValidationRuntimeFingerprint | undefined;
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
      if (run.status === "passed" || run.status === "failed") return;
      // A version run tested an existing signed Artifact; there is no candidate to bind.
      const candidate = input.status === "passed" && run.subject === "draft"
        ? await this.verifiedCandidate(tx, run, input.candidateArtifact)
        : { status: input.status, reason: input.reason ?? null };
      resumeDefault = run.subject === "draft" && run.guardrailId === DEFAULT_GUARDRAIL_ID && run.createdBy === null && candidate.status === "passed";
      await tx.update(validationRuns).set({
        status: candidate.status,
        metrics: input.metrics,
        results: input.results,
        failureReason: candidate.reason,
        completedAt: new Date(),
        runtimeFingerprint: input.runtime ?? null,
        ...("artifact" in candidate ? { candidateArtifact: candidate.artifact, candidateDigest: candidate.digest } : {}),
      }).where(eq(validationRuns.id, input.runId));
      await tx.update(outboxEvents).set({ processedAt: new Date() }).where(eq(outboxEvents.id, input.runId));
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.validation_completed", actorId: null,
        resourceType: "guardrail", resourceId: run.guardrailId,
        detail: { runId: input.runId, status: candidate.status, complianceRate: input.metrics.complianceRate, ...("digest" in candidate ? { candidateDigest: candidate.digest } : {}) },
      });
    });
    // Reconcile after committing the result. Initialization is idempotent and
    // will re-check the current revision/customization before requesting a
    // compile; a late result must never publish a newer, untested draft.
    if (resumeDefault) await this.initialize();
  }

  /**
   * A passed run is only evidence for content it actually executed. Bind the
   * returned candidate to the exact request (Guardrail, version, executable
   * plan and runtime profile); anything else turns the run into a failure.
   */
  private async verifiedCandidate(
    tx: Transaction,
    run: typeof validationRuns.$inferSelect,
    returned: ArtifactContent | undefined,
  ): Promise<{ status: "passed"; reason: null; artifact: ArtifactContent; digest: string } | { status: "failed"; reason: string }> {
    if (!returned) return { status: "failed", reason: "The Runner did not return the tested Artifact. Upgrade the Runner and run tests again." };
    const [request] = await tx.select().from(outboxEvents).where(and(
      eq(outboxEvents.id, run.id), eq(outboxEvents.kind, "guardrail.validation_requested"),
    )).limit(1);
    const plan = request?.payload.plan;
    const profile = request?.payload.runtimeProfile;
    // Keep exactly what a Runner decodes, so every environment computes one digest.
    const artifact = canonicalArtifactContent(artifactContent(returned), this.config.protoPath);
    if (artifact.guardrailId !== run.guardrailId || artifact.guardrailVersion !== run.guardrailVersion
      || !plan || typeof plan !== "object" || Array.isArray(plan)
      || canonicalJson(planToWire(artifact.plan)) !== canonicalJson(planToWire(plan as Record<string, unknown>))
      || !["", "auto", artifact.runtimeProfile].includes(String(profile ?? ""))) {
      return { status: "failed", reason: "The tested Artifact does not match the requested candidate. Run tests again." };
    }
    return { status: "passed", reason: null, artifact, digest: artifactContentDigest(artifact) };
  }

  /**
   * Publish exactly the candidate a passed run tested: same content, same
   * digest, signed by this environment. Nothing is rebuilt from the draft or
   * the Policy Library.
   */
  private async publishValidatedCandidate(
    tx: Transaction,
    guardrail: typeof guardrails.$inferSelect,
    run: typeof validationRuns.$inferSelect,
    actorId: string | null,
  ) {
    const candidate = run.candidateArtifact;
    if (!candidate || !run.candidateDigest || !run.candidateInspection || !run.testSuite
      || testSuiteDigest(run.testSuite) !== run.candidateInspection.testSuite.digest) {
      throw new ConflictError(
        "This test run has no frozen Artifact to publish. Run tests again before publishing.",
        "guardrail_validation_required",
        { draftRevision: guardrail.draftRevision },
      );
    }
    const content = artifactContent(candidate);
    const checksum = artifactContentDigest(content);
    if (checksum !== run.candidateDigest) throw new ConflictError("The stored test candidate no longer matches its digest.", "guardrail_candidate_corrupt");
    const [state] = await tx.update(controllerState)
      .set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
      .where(eq(controllerState.id, "singleton")).returning();
    if (!state) throw new Error("Controller state is not initialized.");
    const [artifact] = await tx.insert(artifacts).values({
      ...content,
      id: randomUUID(),
      generation: state.desiredGeneration,
      checksum,
      signature: signArtifactDigest(checksum, this.config.artifactSigningKeyPath),
    }).onConflictDoNothing().returning();
    const stored = artifact ?? (await tx.select().from(artifacts).where(eq(artifacts.checksum, checksum)))[0];
    if (!stored || stored.guardrailId !== guardrail.id || stored.guardrailVersion !== run.guardrailVersion) {
      throw new ConflictError("Artifact checksum is already bound to different content.", "artifact_checksum_conflict");
    }
    await tx.insert(guardrailVersions).values({
      guardrailId: guardrail.id,
      version: run.guardrailVersion,
      generation: state.desiredGeneration,
      sourceDraftRevision: run.sourceDraftRevision,
      sourceSnapshot: { draftConfig: guardrail.draftConfig, runtimeProfile: guardrail.runtimeProfile, loggingLevel: guardrail.loggingLevel, excludedTestCaseIds: guardrail.excludedTestCaseIds, testCases: await tx.select().from(testCases).where(eq(testCases.guardrailId, guardrail.id)) },
      status: "ready",
      runtimeProfile: guardrail.runtimeProfile,
      plan: content.plan,
      artifactId: stored.id,
      validationRunId: run.id,
      inspection: run.candidateInspection,
      testSuite: run.testSuite,
      // Publishing here already required this passed run: the version is released at once.
      releasedAt: new Date(),
      releasedBy: actorId,
      createdBy: actorId,
    });
    await tx.update(guardrails).set({
      status: "active",
      desiredGeneration: state.desiredGeneration,
      updatedAt: new Date(),
    }).where(eq(guardrails.id, guardrail.id));
    // A fresh installation has no basic protection until its first Default
    // version exists; that version becomes the baseline. Every later switch
    // is explicit (PUT /api/v1/system/baseline).
    const bootstrapBaseline = guardrail.id === DEFAULT_GUARDRAIL_ID
      && (await tx.update(controllerState).set({ baselineVersion: run.guardrailVersion })
        .where(and(eq(controllerState.id, "singleton"), isNull(controllerState.baselineVersion))).returning()).length > 0;
    await tx.insert(outboxEvents).values({
      id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: guardrail.id,
      payload: { guardrailId: guardrail.id, version: run.guardrailVersion, generation: state.desiredGeneration, artifactId: stored.id, ...(bootstrapBaseline ? { baseline: true } : {}) },
    });
    await tx.insert(auditEvents).values({
      id: randomUUID(), kind: "guardrail.published", actorId,
      resourceType: "guardrail", resourceId: guardrail.id,
      detail: { version: run.guardrailVersion, generation: state.desiredGeneration, artifactId: stored.id, contentDigest: checksum, validationRunId: run.id },
    });
    return { guardrailId: guardrail.id, version: run.guardrailVersion, generation: state.desiredGeneration, status: "ready" as const, artifactId: stored.id };
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
    if (id.startsWith("call:")) {
      const source = callFailureEvents(this.db).as("call_failures");
      const [event] = await boundedRead(this.db, tx => tx.select().from(source).where(eq(source.id, id)).limit(1));
      if (!event) throw new NotFoundError("Runtime event", id);
      return event;
    }
    // Exclude large bodies in SQL, before the database driver allocates them in Node.
    const metadata = includeContent ? runtimeEvents.metadata : sql<Record<string, unknown>>`(${runtimeEvents.metadata} - 'contentCiphertext' - 'contentBefore' - 'contentAfter' - 'httpRequest') || jsonb_build_object('contentAvailable',
      (${this.runtimeLogEncryptionKey !== null} AND coalesce(${runtimeEvents.metadata}->>'contentCiphertext', '') <> '')
      OR ${runtimeEvents.metadata}->'contentBefore' IS NOT NULL AND ${runtimeEvents.metadata}->'contentBefore' <> 'null'::jsonb
      OR ${runtimeEvents.metadata}->'httpRequest' IS NOT NULL AND ${runtimeEvents.metadata}->'httpRequest' <> 'null'::jsonb
      OR ${runtimeEvents.metadata}->'contentAfter' IS NOT NULL AND ${runtimeEvents.metadata}->'contentAfter' <> 'null'::jsonb)`;
    const [item] = await boundedRead(this.db, tx => tx.select({ ...getTableColumns(runtimeEvents), metadata }).from(runtimeEvents).where(eq(runtimeEvents.id, id)).limit(1));
    if (!item) throw new NotFoundError("Runtime event", id);
    const { contentCiphertext: _ciphertext, contentBefore: _before, contentAfter: _after, httpRequest: _httpRequest, ...safe } = item.metadata;
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
    until?: Date | undefined;
    cursor?: string | undefined;
    requestId?: string | undefined;
    direction?: string | undefined;
    outcome?: string | undefined;
    captured?: boolean | undefined;
    findingsOnly?: boolean | undefined;
    severity?: EventSeverity | EventSeverity[] | undefined;
  }) {
    const runtimeEvents = runtimeLogSource(this.db);
    let cursor: { at: string; id: string } | undefined;
    if (input.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
        if (!cursor || typeof cursor.at !== 'string' || !Number.isFinite(Date.parse(cursor.at)) || typeof cursor.id !== 'string') throw new Error();
      } catch { throw new ValidationError("Invalid event cursor"); }
    }
    const findings = jsonElements(jsonValue(runtimeEvents.metadata, 'findings'), 'finding');
    const trace = jsonElements(jsonValue(runtimeEvents.metadata, 'trace'), 'error_span');
    const executionError = or(
      inArray(lowerText(runtimeEvents.decision), ['error','failed','failure','timeout','timed_out']),
      eq(jsonText(runtimeEvents.metadata, 'executionStatus'), 'error'),
      eq(jsonText(runtimeEvents.metadata, 'timedOut'), 'true'),
      eq(jsonText(runtimeEvents.metadata, 'timed_out'), 'true'),
      exists(this.db.select({ item: findings.item }).from(findings.source).where(eq(jsonText(findings.item, 'verdict'), 'error'))),
      exists(this.db.select({ item: trace.item }).from(trace.source).where(or(
        eq(jsonText(trace.item, 'verdict'), 'error'), eq(jsonText(trace.item, 'timedOut'), 'true'),
        inArray(jsonText(trace.item, 'status'), ['error','failed','timeout']),
        inArray(jsonText(trace.item, 'outcome'), ['error','failed','timeout']),
      ))),
    );
    const severities = input.severity ? (Array.isArray(input.severity) ? input.severity : [input.severity]) : [];
    const conditions = [
      severities.length ? exists(this.db.select({ severity: findingSeverity(findings.item) }).from(findings.source).where(and(securityFinding(findings.item), inArray(findingSeverity(findings.item), severities)))) : undefined,
      cursor ? lt(rowValue(runtimeEvents.occurredAt, runtimeEvents.id), rowValue(timestampValue(cursor.at), literal(cursor.id))) : undefined,
      input.requestId ? eq(runtimeEvents.requestId, input.requestId) : undefined,
      input.direction ? eq(runtimeEvents.direction, input.direction) : undefined,
      input.outcome === 'error' ? executionError : input.outcome ? inArray(lowerText(runtimeEvents.decision), input.outcome === 'allow' ? ['allow','allowed','pass','passed'] : input.outcome === 'block' ? ['block','blocked','block','rejected','deny','denied'] : input.outcome === 'transform' ? ['transform','transformed','transform','redacted','transform','rewritten','intervene','intervened'] : ['error','failed','failure','timeout','timed_out']) : undefined,
      input.captured ? eq(jsonText(runtimeEvents.metadata, 'runtimeLogCaptured'), 'true') : undefined,
      input.findingsOnly ? exists(this.db.select({ item: findings.item }).from(findings.source).where(securityFinding(findings.item))) : undefined,
      input.guardrailId ? eq(runtimeEvents.guardrailId, input.guardrailId) : undefined,
      input.routerId ? eq(runtimeEvents.routerId, input.routerId) : undefined,
      input.routeId ? eq(jsonText(runtimeEvents.metadata, "routeId"), input.routeId) : undefined,
      input.targetId ? eq(jsonText(runtimeEvents.metadata, "targetId"), input.targetId) : undefined,
      input.routerRevision ? eq(jsonText(runtimeEvents.metadata, "routerRevision"), String(input.routerRevision)) : undefined,
      input.endpointId ? eq(runtimeEvents.endpointId, input.endpointId) : undefined,
      input.since ? gte(runtimeEvents.occurredAt, input.since) : undefined,
      input.until ? lte(runtimeEvents.occurredAt, input.until) : undefined,
      input.before ? lte(runtimeEvents.occurredAt, input.before) : undefined,
    ].filter((item): item is NonNullable<typeof item> => Boolean(item));
    const predicate = conditions.length ? and(...conditions) : undefined;
    // SQL projection is essential: discarding metadata after SELECT still allocates the full payload in Node.
    return boundedRead(this.db, async tx => {
    const findingSummary = jsonObject(Object.fromEntries(['id','risk','verdict','confidence','taxonomyId','recommendedAction','policyId','ruleId','riskSeverity','policyVersion'].map(key => [key, jsonValue(findings.item, key)])));
    const metadata = jsonObject({
      ...Object.fromEntries(['executionStatus','captureLevel','runtimeLogCaptured','protocol','action','timedOut','timed_out','streamFinalCheck','routeId','targetId','routerRevision','decisionId','logKind','completionInferred','failureReason','completedAt'].map(key => [key,jsonValue(runtimeEvents.metadata, key)])),
      executionStatus: sql`CASE WHEN ${executionError} THEN 'error' ELSE ${jsonText(runtimeEvents.metadata, 'executionStatus')} END`,
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

  async listAuditEvents(query: Partial<AuditQuery> = {}) {
    return queryAuditEvents(this.db, query);
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
      throw new ValidationError("The Default Guardrail is the built-in baseline and cannot be removed.");
    }
    const [resource] = await this.db.select().from(guardrails).where(and(eq(guardrails.id, id), isNull(guardrails.deletedAt)));
    if (!resource) throw new NotFoundError("Guardrail", id);
    // Published Router revisions are the only live references; composed
    // Routers roll out through the default pool today.
    const published = await this.db.select({ activeSnapshot: trafficRouters.activeSnapshot }).from(trafficRouters)
      .where(and(isNull(trafficRouters.deletedAt), isNotNull(trafficRouters.activeRevision)));
    const referencing = published.filter((router) => router.activeSnapshot?.routes.some((route) => route.targets.some((target) => target.guardrailId === id)));
    return this.deletionImpact("guardrail", id, referencing.map(() => "default"));
  }

  async endpointDeletionImpact(id: string): Promise<DeletionImpact> {
    const [resource] = await this.db.select().from(endpoints).where(and(eq(endpoints.id, id), isNull(endpoints.deletedAt)));
    if (!resource) throw new NotFoundError("Endpoint", id);
    const [bound] = resource.trafficRouterId ? await this.db.select({ id: trafficRouters.id }).from(trafficRouters)
      .where(and(eq(trafficRouters.id, resource.trafficRouterId), isNull(trafficRouters.deletedAt), isNotNull(trafficRouters.activeRevision))) : [];
    return this.deletionImpact("endpoint", id, bound ? ["default"] : []);
  }

  async softDeleteGuardrail(input: { id: string; actorId: string; reason: string; confirmRecentTraffic: boolean; confirmationName?: string | undefined }) {
    if (input.id === DEFAULT_GUARDRAIL_ID) {
      throw new ValidationError("The Default Guardrail is the built-in baseline and cannot be removed.");
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
      await this.recordSoftDelete(tx, "endpoint", input, impact, state.desiredGeneration);
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
    const routerRevisions = await this.trafficRouting.runtimeSnapshots(tx);
    // Every pool receives the artifacts its published Router revisions pin plus
    // the Default Guardrail baseline. The default pool additionally keeps every
    // locally published ready version, and every imported one whose Runner load
    // check passed, so Playground and internal checks can address it. An
    // imported version that has not passed a check loads only once a Router
    // references it, so an unchecked package can never break an applied release.
    // Whatever is referenced is always delivered, whatever its release state:
    // Runners reject a desired state whose Router targets are missing, so a
    // gap here would stop all traffic rather than one route.
    const referencedArtifactIds = new Set(routerRevisions.flatMap((router) => router.routes.flatMap((route) => route.targets.map((target) => target.artifactId).filter(Boolean))));
    const baseline = await this.baselineVersion(tx);
    const [baselineArtifact] = baseline ? await tx.select({ artifactId: guardrailVersions.artifactId }).from(guardrailVersions)
      .innerJoin(guardrails, and(eq(guardrails.id, guardrailVersions.guardrailId), isNull(guardrails.deletedAt)))
      .where(and(eq(guardrailVersions.guardrailId, DEFAULT_GUARDRAIL_ID), eq(guardrailVersions.version, baseline))) : [];
    if (baselineArtifact?.artifactId) referencedArtifactIds.add(baselineArtifact.artifactId);
    const readyArtifacts = await tx.select({ artifact: artifacts }).from(guardrailVersions)
      .innerJoin(guardrails, and(eq(guardrails.id, guardrailVersions.guardrailId), isNull(guardrails.deletedAt)))
      .innerJoin(artifacts, eq(artifacts.id, guardrailVersions.artifactId))
      .where(or(
        inArray(artifacts.id, [...referencedArtifactIds]),
        and(eq(guardrailVersions.status, "ready"), or(
          eq(guardrailVersions.origin, "local"),
          sql`${guardrailVersions.environmentCheck}->>'status' = 'compatible'`,
        )),
      ));
    const activeArtifacts = poolId === "default"
      ? readyArtifacts
      : readyArtifacts.filter((row) => referencedArtifactIds.has(row.artifact.id));
    const disabledGuardrails = await tx.select({ id: guardrails.id }).from(guardrails).where(eq(guardrails.status, "disabled"));
    const loggingLevels = await tx.select({ id: guardrails.id, level: guardrails.loggingLevel })
      .from(guardrails).where(isNull(guardrails.deletedAt));
    const disabledEndpoints = await tx.select({ id: endpoints.id }).from(endpoints).where(eq(endpoints.status, "disabled"));
    const endpointRows = await tx.select().from(endpoints).where(eq(endpoints.status, "active"));
    return {
      generation,
      artifacts: [...new Map(activeArtifacts.map((row) => [row.artifact.id, row.artifact])).values()],
      disabledGuardrailIds: disabledGuardrails.map((row) => row.id),
      disabledEndpointIds: disabledEndpoints.map((row) => row.id),
      routerRevisions: routerRevisions.map(router => ({ ...router, assignmentAlgorithm: "hmac-sha256-v1", assignmentKeyId: "v1", assignmentKey: createHash("sha256").update("traffic-router-assignment-v1:" + this.config.runnerToken).digest() })),
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

  async listRunnerHeartbeats() {
    return this.db.select({ status: runnerInstances.status, lastHeartbeatAt: runnerInstances.lastHeartbeatAt })
      .from(runnerInstances);
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
      }).from(guardrails).where(isNull(guardrails.deletedAt)),
      this.db.select({
        id: trafficRouters.id,
        name: trafficRouters.name,
        activeRevision: trafficRouters.activeRevision,
        activeSnapshot: trafficRouters.activeSnapshot,
      }).from(trafficRouters).where(isNull(trafficRouters.deletedAt)),
      this.db.select({
        id: endpoints.id,
        name: endpoints.name,
        adapter: endpoints.adapter,
        status: endpoints.status,
        deletedAt: endpoints.deletedAt,
        trafficRouterId: endpoints.trafficRouterId,
      }).from(endpoints),
    ]);
    const guardrailById = new Map(guardrailRows.map((item) => [item.id, item]));
    const endpointBindings = new Map<string, {
      guardrailId: string;
      endpointId: string;
      endpointName: string;
      poolId: string;
      status: "active" | "inactive" | "disabled";
    }>();
    // Topology comes from published Router revisions: one row per pinned
    // target, and one Endpoint binding per bound Endpoint and target Guardrail.
    // Composed Routers roll out through the default pool.
    const poolId = "default";
    const priority = { disabled: 0, inactive: 1, active: 2 } as const;
    const routerTopology = routerRows.flatMap((router) => {
      if (!router.activeSnapshot) return [];
      const boundEndpoints = endpointRows.filter((endpoint) => endpoint.trafficRouterId === router.id && endpoint.deletedAt === null);
      const targets = new Map<string, { guardrailId: string; guardrailVersion: string | null }>();
      for (const route of router.activeSnapshot.routes) {
        if (!route.enabled) continue;
        for (const target of route.targets) {
          if (target.weightBps <= 0) continue;
          const guardrail = guardrailById.get(target.guardrailId);
          if (!guardrail) continue;
          const guardrailVersion = target.guardrailVersion || null;
          targets.set(`${target.guardrailId}\u0000${guardrailVersion ?? ""}`, { guardrailId: target.guardrailId, guardrailVersion });
        }
      }
      return [...targets.values()].map(({ guardrailId, guardrailVersion }) => {
        const guardrail = guardrailById.get(guardrailId)!;
        const status = router.activeRevision === null
          ? "disabled"
          : guardrail.status !== "active" || guardrailVersion === null
            ? "inactive"
            : "active";
        for (const endpoint of boundEndpoints) {
          const bindingStatus = status === "active" && endpoint.status !== "active" ? "inactive" : status;
          const key = `${guardrailId}\u0000${endpoint.id}\u0000${poolId}`;
          const current = endpointBindings.get(key);
          if (!current || priority[bindingStatus] > priority[current.status]) {
            endpointBindings.set(key, { guardrailId, endpointId: endpoint.id, endpointName: endpoint.name, poolId, status: bindingStatus });
          }
        }
        return { guardrailId, guardrailVersion, routerId: router.id, routerName: router.name, poolId, status };
      });
    });
    return {
      watermarks,
      pendingOutbox,
      guardrails: guardrailRows.map((item) => ({
        guardrailId: item.id,
        guardrailName: item.name,
        status: item.status,
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

  async removeRunnerInstance(input: { runnerId: string; actorId: string; force?: boolean; bootId?: string }): Promise<{ bootId: string }> {
    if (input.force && !input.bootId) throw new ValidationError("Force removal requires the Runner boot ID.");
    return this.db.transaction(async (tx) => {
      const [removed] = await tx.delete(runnerInstances)
        .where(and(
          eq(runnerInstances.runnerId, input.runnerId),
          input.force ? inArray(runnerInstances.status, ["offline", "syncing"]) : eq(runnerInstances.status, "offline"),
          input.bootId ? eq(runnerInstances.bootId, input.bootId) : undefined,
        ))
        .returning();

      if (!removed) {
        const [existing] = await tx.select({ status: runnerInstances.status })
          .from(runnerInstances)
          .where(eq(runnerInstances.runnerId, input.runnerId))
          .limit(1);
        if (!existing) throw new NotFoundError("Runner", input.runnerId);
        if (input.force) throw new ConflictError(
          "Runner state or registration changed. Refresh before forcing removal; serving Runners cannot be removed.",
          "runner_removal_conflict",
          { runnerId: input.runnerId, status: existing.status },
        );
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
          ...(input.force ? { force: true, status: removed.status, appliedGeneration: removed.appliedGeneration, desiredGeneration: removed.desiredGeneration } : {}),
          bootId: removed.bootId,
          poolId: removed.poolId,
          lastHeartbeatAt: removed.lastHeartbeatAt.toISOString(),
          disconnectedAt: removed.disconnectedAt?.toISOString() ?? null,
        },
      });
      return { bootId: removed.bootId };
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
    if (draft.rail_bindings.some(binding => !binding.risk_severity)) throw new ValidationError("Choose a risk level for every Rule before testing or publishing.");
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
      const published = await this.lastPublishedVersion(tx, DEFAULT_GUARDRAIL_ID);
      const [enabled] = await tx.update(guardrails).set({
        status: published ? "active" : "draft",
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
    if (!userCustomization && canonicalJson(normalizeGuardrailDraft(stored.draftConfig)) !== canonicalJson(normalizeGuardrailDraft(desiredDraft))) {
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

    const published = await this.lastPublishedVersion(tx, DEFAULT_GUARDRAIL_ID);
    if (published?.artifactId && !baselineChanged
      && (userCustomization || published.sourceDraftRevision === stored.draftRevision)) {
      if (restored) {
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
      eq(validationRuns.subject, "draft"),
      eq(validationRuns.sourceDraftRevision, stored.draftRevision),
    )).orderBy(desc(validationRuns.createdAt)).limit(1);
    if (!validation) {
      await this.enqueueGuardrailValidation(tx, stored, null);
      return;
    }
    // Pending/failed validation is visible in the normal UI. Do not loop on
    // failures at every restart or silently compile around them.
    if (validation.status !== "passed") return;
    const [existingVersion] = await tx.select({ version: guardrailVersions.version }).from(guardrailVersions).where(and(
      eq(guardrailVersions.guardrailId, DEFAULT_GUARDRAIL_ID),
      eq(guardrailVersions.version, validation.guardrailVersion),
    )).limit(1);
    if (existingVersion) return;
    // A run that passed before candidates were retained cannot be published.
    if (!validation.candidateArtifact) {
      await this.enqueueGuardrailValidation(tx, stored, null);
      return;
    }
    await this.publishValidatedCandidate(tx, stored, validation, null);
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
    // The draft's own testing state; runs against existing versions are not about
    // the draft. Imported Guardrails have no draft, so their latest report is the
    // latest test of one of their versions here.
    const [latestValidation] = await this.db.select().from(validationRuns)
      .where(and(eq(validationRuns.guardrailId, row.id), eq(validationRuns.subject, row.origin === "imported" ? "version" : "draft")))
      .orderBy(desc(validationRuns.createdAt)).limit(1);
    const [caseCount] = await this.db.select({ value: count() }).from(testCases)
      .where(eq(testCases.guardrailId, row.id));
    const published = await this.lastPublishedVersion(this.db, row.id);
    // Imported Guardrails have no working draft: their versions are the whole state.
    let hasUnpublishedChanges = row.origin !== "imported" && (!published || published.sourceDraftRevision !== row.draftRevision);
    if (hasUnpublishedChanges && published?.sourceSnapshot?.testCases) {
      const cases = await this.db.select().from(testCases).where(eq(testCases.guardrailId, row.id));
      hasUnpublishedChanges = !sameDraftContent(published.sourceSnapshot, { draftConfig: row.draftConfig, runtimeProfile: row.runtimeProfile,
        loggingLevel: row.loggingLevel, excludedTestCaseIds: row.excludedTestCaseIds, testCases: cases });
    }
    const { duplicateKey: _duplicateKey, copyOrigin, ...publicRow } = row;
    const { requestDigest: _requestDigest, ...publicOrigin } = copyOrigin ?? {};
    return {
      ...publicRow,
      copyOrigin: copyOrigin ? publicOrigin : null,
      draftConfig: normalizeGuardrailDraft(row.draftConfig),
      latestValidationRun: latestValidation ? publicValidationRun(latestValidation) : null,
      testCaseCount: caseCount?.value ?? 0,
      excludedTestCaseCount: row.excludedTestCaseIds.length,
      // The draft revision the last publication came from; null before any.
      publishedSourceDraftRevision: published?.sourceDraftRevision ?? null,
      hasUnpublishedChanges,
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
  const rules = surface.rail_bindings.map((binding) => flowRule(record.id, String(latest?.version ?? 0), binding));
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
    compliance: customPolicyCompliance({
      id: record.id, name: latest?.snapshot.name ?? record.name,
      description: latest?.snapshot.description ?? record.description,
      version: String(latest?.version ?? 0), rules,
    }, latest?.snapshot.owner ?? record.owner),
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
    detectors: [...new Set(rules.map(rule => rule.detector.ref))],
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
  const action = snapshot.rail_bindings[0]?.on_unsafe ?? "block";
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
      rule_severities: snapshot.rail_bindings.filter(item => item.risk_severity).map(item => [flowRuleId(item.rail_type, item.flow_name), item.risk_severity]),
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
  const { contentCiphertext: _ciphertext, ...metadata } = value;
  if (!decrypted) return { ...metadata, contentAvailable: Boolean(metadata.httpRequest || metadata.contentBefore || metadata.contentAfter) };
  return {
    ...metadata,
    contentBefore: decrypted.contentBefore ?? null,
    contentAfter: decrypted.contentAfter ?? null,
    httpRequest: decrypted.httpRequest ?? null,
    contentAvailable: true,
  };
}

/** Test reports carry the candidate's digest; its full content stays server-side. */
// The frozen suite is read through the version; results already echo each case.
function publicValidationRun({ candidateArtifact: _candidateArtifact, testSuite: _testSuite, ...run }: typeof validationRuns.$inferSelect) {
  return run;
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
    stream_callback_url: isLiteLLM ? null : `${apiBaseUrl.replace(/^http/, "ws")}/guardrails/output-stream`,
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
