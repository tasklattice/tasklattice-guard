import {RunnerDirectory} from "./runner-directory.js";
import { UserDirectory } from "./user-directory.js";
import { isRunnerName } from "../../shared/runner-naming.js";
import { projectPoolAllocation } from "./runner-allocation.js";
import { executionError as runtimeExecutionError } from "./runtime-execution.js";
import { ReportResults, type ReportUploadIdentity } from "./report-results.js";
import { KeyedWorkQueue, PendingWork } from "../work-queue.js";
import { logDatabaseFailure } from "../db/diagnostics.js";
import type { ArtifactCompiler } from "../domain/artifact-compilation.js";
import { artifactExecutionContractIssue } from "../domain/artifact-execution-contract.js";
import { writeRuntimeEvent } from "./runtime-event-write.js";
import { issueEndpointTelemetryContexts, lockEndpointTelemetryContextReaders, pruneEndpointTelemetryContexts as pruneEndpointContexts } from "./endpoint-telemetry-contexts.js";
import { ProjectAdmissionMonitor } from "./admission-monitor.js";
import { localBaseline } from "../../shared/local-baseline.js";
import bundledDefault from "../domain/default-baseline.json" with { type: "json" };
import { querySecurityEvents } from "./security-events.js";
import type { SecurityEventsQuery } from "../../shared/security-events.js";
import { ModelPricingService, modelUsageCostRecorder } from "./model-pricing.js";
import { telemetryBatches, telemetryWatermarkBatch } from "./telemetry-batches.js";
import { pruneTestingReports } from "./testing-report-retention.js";
import { limitValidationWrite } from "./validation-write-limits.js";
import { databasePoolState, reportSaveStage, withReportSaveDiagnostics } from "../db/diagnostics.js";
import { queryTestingReports, validationSummaryColumns, storeValidationSnapshot, type ValidationSnapshot, validationSnapshotColumns, testingReportsQuery } from "./testing-reports.js";
import type { z } from "zod";
import type { TestingReportDeletionImpact } from "../../shared/testing-report-deletion.js";
import { assertGuardrailVersionCapacity, guardrailVersionCapacityIssue } from "./guardrail-version-limit.js";
import { clearGuardrailOperationalData, guardrailTelemetryFilter } from "./guardrail-operational-data.js";
import { callFailureEvents, runtimeLogSource } from "./runtime-log-source.js";
import { advancesValidationProgress, type ValidationProgress } from "../../shared/validation-progress.js";
import { queryAuditEvents } from "./audit-events.js";
import type { AuditQuery } from "../../shared/audit-query.js";
import type { EventSeverity } from "../../shared/security-severity.js";
import { readGuardrailProfiles } from "./guardrail-profiles.js";
import { previewProtectionProfile, profileDraft } from "../policy-catalog/presets.js";
import { TrafficRoutingService } from "./traffic-routing.js";
import { ProjectGroupRouting } from "./project-group-routing.js";
import { ProjectGroupService } from "./project-groups.js";
import { RunnerControlSessionStore } from "./runner-control-sessions.js";
import { ProtectionModeService } from "./protection-modes.js";
import { resetProtectionMode } from "../../shared/protection-mode.js";
import { GuardrailPackageService } from "./guardrail-packages.js";
import { validateTestScope } from "../domain/validation-scope.js";
import { PolicyResourceService } from "./policy-resources.js";
import type { ArtifactAdmission } from "../domain/environment-check.js";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../../shared/canonical-json.js";
import { scanRequestCommand } from "../../shared/scan-request-command.js";
import { artifactContent, artifactContentDigest, ARTIFACT_CONTENT_DIGEST_VERSION, signArtifactDigest, type ArtifactContent } from "../domain/artifact-content.js";
import { canonicalArtifactContent } from "../control-channel/artifact-codec.js";
import { programmablePolicyProtection } from "../policy-studio/protection.js";
import { queryRuntimeMetrics, type MetricScope } from "./runtime-metrics.js";
import { boundedRead } from '../db/read-budget.js';
import { createDatabaseReadiness } from "../db/readiness.js";
import { asText, findingSeverity, securityFinding, increment, jsonAggregate, jsonArrayLength, jsonElements, jsonObject, jsonText, jsonValue, literal, rowValue, scalar, timestampValue } from '../db/postgres-expressions.js';
import { advisoryTransactionLock } from '../db/postgres-locks.js';

import { and, asc, count, countDistinct, desc, eq, exists, getTableColumns, gt, gte, inArray, isNotNull, isNull, lt, lte, max, min, ne, notInArray, or, sql, type SQL } from "drizzle-orm";

import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { planToWire } from "../control-channel/protocol-codec.js";
import { describeDraftChanges, draftConfigContent, sameDraftContent, stableDraftValue, type DraftSnapshot } from "../domain/guardrail-draft-changes.js";
import type { GuardrailDraftChanges } from "../../shared/guardrail-draft-changes.js";
import {
  artifacts,
  auditEvents,
  controllerState,
  deploymentPresets,
  guardrails,
  guardrailVersionProvenance,
  guardrailVersions,
  trafficRouters,
  trafficRouterChangeRequests,
  trafficRouterRevisions,
  routeAssignments,
  endpoints,
  outboxEvents,
  policyImportedVersions,
  policyRecords,
  policyResources,
  policyResourceVersions,
  policyResourceValidations,
  playgroundInvocations,
  guardrailProfiles,
  policyValidationRuns,
  policyVersions,
  runnerInstances,
  runnerControlSessions,
  runnerPools,
  runnerPoolLeaseEpochs,
  runtimeEvents,
  projectGroups,
  projects,
  telemetryWatermarks,
  testCases,
  validationRuns,
  type RunnerLoad,
} from "../db/schema.js";
import { calculatePoolCapacity } from "../domain/capacity.js";
import { publishedProtectionCoverage } from "../domain/protection-readiness.js";
import { decodeRuntimeLogKey, decryptRuntimeLogPayload } from "../runtime-log-crypto.js";
import { ConflictError, ControllerError, NotFoundError, ValidationError } from "../domain/errors.js";
import { buildGuardrailPlan, normalizeGuardrailDraft, type GuardrailDraftConfig } from "../domain/guardrail-plan.js";
import type { DeletionImpact, RuntimeEventInput, ValidationCaseResult, ValidationMetrics, ValidationRuntimeFingerprint } from "../domain/models.js";
import { guardrailInspection } from "../domain/guardrail-inspection.js";
import { freezeTestSuite, testSuiteDigest } from "../domain/test-suite.js";
import { builtInPolicyView, guardrailPolicyNodes } from "../domain/policy-node.js";
import { applyValidationOverrides, emptyValidationMetrics, generatedTestCases, reconcileValidationOverrides } from "../domain/validation.js";
import { PolicyCatalog, type PolicyDto } from "../policy-catalog/catalog.js";
import { customPolicyCompliance } from "../policy-catalog/compliance.js";
import { registeredAction } from "../action-catalog/catalog.js";
import type { ValidationTerminalState } from "../../shared/lifecycle.js";
import { guardrailCategoryLabels } from "../../shared/guardrail-catalog.js";
import { guardrailVersionId } from "../../shared/guardrail-version.js";
import type { GuardrailVersionDeletionBlocker, GuardrailVersionDeletionImpact } from "../../shared/guardrail-version-deletion.js";

type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];
type PublicationCandidate = Pick<typeof validationRuns.$inferSelect,
  "guardrailVersion" | "sourceDraftRevision" | "candidateDigest"> & ValidationSnapshot & { id: string | null };
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
import {
  assertResourceReadAccess,
  assertResourceWriteAccess,
  assertPlatformAuthority,
  runWithProjectContext,
  currentProjectId,
  resourceReadPredicate,
  resourceWritePredicate,
  projectOwnerForCreate,
} from "./project-context.js";

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
  readonly users: UserDirectory;
  readonly runners: RunnerDirectory;
  async pruneEndpointTelemetryContexts(): Promise<number> {
    assertPlatformAuthority();
    if (!this.config.runnerScopedTelemetry) return 0;
    return this.db.transaction(tx => pruneEndpointContexts(tx));
  }
  private lastPlaygroundInvocationCleanup = 0;
  readonly projectGroups: ProjectGroupService;
  readonly runnerControlSessions: RunnerControlSessionStore;
  readonly admissionMonitor: ProjectAdmissionMonitor;
  databasePoolState() { return databasePoolState(this.db); }
  readonly pricing: ModelPricingService;
  readonly reportResults: ReportResults;
  private readonly reportMaintenance = new KeyedWorkQueue<string>(1);
  private readonly reportJobs = new PendingWork();
  private reportTimer: NodeJS.Timeout | undefined;
  private reportStopping = false;
  private readonly reportSaves = new Map<string, Promise<void>>();
  private reportDecoderState: () => Record<string, { active: number; queued: number; in_flight_bytes: number }> = () => ({});
  setReportDecoderState(read: typeof this.reportDecoderState) { this.reportDecoderState = read; }
  reportWorkState() { return { ...this.reportResults.state(), ...this.reportDecoderState() }; }
  private queueReportPrune(guardrailId: string) {
    if (this.reportStopping) return;
    this.reportJobs.track(this.reportMaintenance.run(guardrailId, async () => {
      for (;;) {
        const removed = await this.db.transaction(async tx => {
          const [guardrail] = await tx.select({ id: guardrails.id }).from(guardrails).where(eq(guardrails.id, guardrailId)).for("update");
          return guardrail ? reportSaveStage("prune_history", () => pruneTestingReports(tx, guardrailId, 1)) : 0;
        });
        if (!removed || this.reportStopping) return;
      }
    })).catch(error => logDatabaseFailure("validation.report_maintenance_failed", error, this.databasePoolState(), { operation: "prune_reports" }));
  }
  startReportMaintenance() {
    const scan = async () => {
      await this.db.execute(sql`DELETE FROM guardrail_validation_snapshot WHERE digest IN (SELECT s.digest FROM guardrail_validation_snapshot s WHERE NOT EXISTS (SELECT 1 FROM guardrail_validation_run r WHERE r.snapshot_digest=s.digest) LIMIT 100)`);
      const rows = await this.db.select({ id: guardrails.id }).from(guardrails);
      for (const row of rows) this.queueReportPrune(row.id);
    };
    const tick = () => { if (!this.reportStopping) void this.reportJobs.track(this.reportMaintenance.run("__scan__", scan)).catch(error => logDatabaseFailure("validation.report_maintenance_failed", error, this.databasePoolState(), { operation: "maintain_reports" })); };
    tick();
    this.reportTimer = setInterval(tick, 30_000);
    this.reportTimer.unref();
  }
  async drainReportWork() { await this.reportJobs.drain(); }
  async stopReportWork() { this.reportStopping = true; clearInterval(this.reportTimer); await this.drainReportWork(); }
  private resources: PolicyResourceService | null = null;
  get policyResources(): PolicyResourceService {
    return this.resources ??= new PolicyResourceService(this.db, this.config.policyCatalogDir, () => this.policyCatalog().list(), this.reportResults);
  }
  readonly trafficRouting: TrafficRoutingService;
  readonly groupRouting: ProjectGroupRouting;
  readonly protectionModes: ProtectionModeService;
  readonly packages: GuardrailPackageService;
  private catalog: PolicyCatalog | null = null;
  private artifactCompiler: ArtifactCompiler | null = null;

  setArtifactCompiler(compiler: ArtifactCompiler): void { this.artifactCompiler = compiler; }
  private readonly runtimeLogEncryptionKey: Buffer | null;

  constructor(
    private readonly db: ControllerDatabase,
    private readonly config: ControllerConfig,
  ) {
    this.pricing = new ModelPricingService(db);
    this.projectGroups = new ProjectGroupService(db, config.experimentalRunnerLeaseGrants);
    this.users = new UserDirectory(db);
    this.runners = new RunnerDirectory(db, config.heartbeatIntervalSeconds);
    this.runnerControlSessions = new RunnerControlSessionStore(db);
    this.admissionMonitor = new ProjectAdmissionMonitor(db, { staleAfterMs: config.heartbeatIntervalSeconds * 3000 });
    this.trafficRouting = new TrafficRoutingService(db, config.runnerScopedTelemetry);
    this.groupRouting = new ProjectGroupRouting(db, config);
    this.reportResults = new ReportResults(db);
    this.protectionModes = new ProtectionModeService(db, config.offlineAfterSeconds);
    this.packages = new GuardrailPackageService(db, config, () => this.policyCatalog().list());
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
        name: "runner-default",
        isDefault: true,
        desiredReplicas: 1,
        safeRpsPerRunner: 50,
        maxConcurrencyPerRunner: 64,
      }).onConflictDoNothing();
      await advisoryTransactionLock(tx, 'tasklattice-guard-product-defaults');
      // Provision the pinned Profile once, independently of model setup.
      await this.ensureDefaultGuardrail(tx);
    });
  }

  /** Provision existing Projects in bounded batches; new Projects use the same transaction hook. */
  async initializeProjects(): Promise<void> {
    assertPlatformAuthority();
    while (true) {
      const batch = await this.db.select({ id: projects.id }).from(projects)
        .where(sql`not exists (select 1 from ${deploymentPresets}
          where ${deploymentPresets.key} = 'project-default:' || ${projects.id})`)
        .orderBy(projects.id).limit(25);
      if (!batch.length) return;
      for (const project of batch) await this.db.transaction(tx => this.initializeProject(tx, project.id));
    }
  }

  async initializeProject(tx: Transaction, projectId: string): Promise<void> {
    assertPlatformAuthority();
    await advisoryTransactionLock(tx, `project-default:${projectId}`);
    await runWithProjectContext({ projectId }, () => this.ensureDefaultGuardrail(tx, projectId));
  }

  /**
   * The version a working draft is compared with: the one most recently
   * published or released here. It only answers "what changed since publishing"; no
   * Router or export ever follows it.
   */
  private async lastPublishedVersion(db: Pick<ControllerDatabase, "select">, guardrailId: string) {
    const [row] = await db.select().from(guardrailVersions).where(and(
      eq(guardrailVersions.guardrailId, guardrailId), eq(guardrailVersions.status, "ready"),
    )).orderBy(desc(guardrailVersions.createdAt), desc(guardrailVersions.version)).limit(1);
    return row ?? null;
  }

  async desiredGeneration(): Promise<number> {
    const [state] = await this.db.select().from(controllerState).where(eq(controllerState.id, "singleton"));
    return state?.desiredGeneration ?? 0;
  }

  private readinessProbe: (() => Promise<number>) | undefined;
  readiness(): Promise<number> {
    this.readinessProbe ??= createDatabaseReadiness(this.db.$client);
    return this.readinessProbe();
  }

  async listGuardrailProfiles() {
    const profiles = await readGuardrailProfiles(this.db);
    const policies = await this.listPolicies();
    return profiles.map(profile => previewProtectionProfile(profile, policies));
  }

  async listPolicies() {
    const custom = await this.db.select().from(policyRecords)
      .where(resourceReadPredicate("policy", policyRecords.id, policyRecords.projectId))
      .orderBy(asc(policyRecords.name), asc(policyRecords.id));
    const versions = custom.length ? await this.db.select().from(policyVersions)
      .where(inArray(policyVersions.policyId, custom.map((item) => item.id)))
      .orderBy(desc(policyVersions.version)) : [];
    const versionsByPolicy = new Map<string, typeof versions>();
    for (const version of versions) {
      const items = versionsByPolicy.get(version.policyId) ?? [];
      items.push(version);
      versionsByPolicy.set(version.policyId, items);
    }
    return [
      ...(await this.catalogPolicies()).filter(policy => !policy.retired),
      ...custom.map((item) => programmablePolicyPayload(item, versionsByPolicy.get(item.id) ?? [])),
    ];
  }

  /**
   * The catalog, plus catalog Policy versions a release package brought that
   * this installation does not ship: read-only versions of the same Policy,
   * or a Policy of their own when the catalog has no such ID.
   */
  private async catalogPolicies(id?: string, db: Pick<ControllerDatabase, "select"> = this.db): Promise<PolicyDto[]> {
    const rows = await db.select().from(policyImportedVersions)
      .where(and(id ? eq(policyImportedVersions.policyId, id) : undefined, resourceReadPredicate("policy", policyImportedVersions.policyId, policyImportedVersions.projectId)));
    const imported = new Map<string, PolicyDto[]>();
    for (const row of rows) {
      const compiled = row.definition.definition
        ? this.policyResources.compiler.compile(this.policyResources.compiler.fromSnapshot(row.definition))
        : builtInPolicyView(row.definition);
      const view = { ...compiled, origin: "imported", source_id: row.sourceId } as unknown as PolicyDto;
      imported.set(row.policyId, [...imported.get(row.policyId) ?? [], view]);
    }
    const newestFirst = (items: PolicyDto[]) => [...items].sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }));
    const catalog = id ? [this.policyCatalog().get(id)].filter((item): item is PolicyDto => Boolean(item))
      : this.policyCatalog().list();
    const shipped = new Set(catalog.map((policy) => policy.id));
    const views = await this.policyResources.views([
      ...catalog.map((policy) => imported.has(policy.id)
        ? { ...policy, published_versions: [...policy.published_versions ?? [], ...newestFirst(imported.get(policy.id)!)] }
        : policy),
      ...[...imported].filter(([policyId]) => !shipped.has(policyId)).map(([, versions]) => {
        const [head, ...rest] = newestFirst(versions);
        return { ...head!, published_versions: rest };
      }),
    ], db, id);
    return views.map(policy => ({ ...policy, deletable: !this.policyCatalog().get(policy.id) }));
  }

  async getPolicy(id: string) {
    const [builtIn] = await this.catalogPolicies(id);
    if (builtIn) return builtIn;
    const [record] = await this.db.select().from(policyRecords).where(and(
      eq(policyRecords.id, id), resourceReadPredicate("policy", policyRecords.id, policyRecords.projectId),
    ));
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
        projectId: projectOwnerForCreate(),
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
    await assertResourceWriteAccess(this.db, "policy", input.id);
    const [updated] = await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(policyRecords).where(and(
        eq(policyRecords.id, input.id), resourceWritePredicate(policyRecords.projectId),
      )).for("update");
      if (!current) throw new NotFoundError("Policy", input.id);
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
    await assertResourceWriteAccess(this.db, "policy", input.id);
    await this.db.transaction(async (tx) => {
      if (this.policyCatalog().get(input.id)) throw new ValidationError("Built-in Policies are system managed and cannot be deleted.");
      // Package import can create Policy rows in a different representation.
      // Serialize it with the ownership check and hard deletion.
      await advisoryTransactionLock(tx, "guardrail-package-import");
      await advisoryTransactionLock(tx, `policy-resource:${input.id}`);
      const [resource] = await tx.select().from(policyResources).where(eq(policyResources.id, input.id)).for("update");
      const [record] = await tx.select().from(policyRecords).where(eq(policyRecords.id, input.id)).for("update");
      const imported = await tx.select().from(policyImportedVersions).where(eq(policyImportedVersions.policyId, input.id)).for("update");
      if (!resource && !record && !imported.length) throw new NotFoundError("Policy", input.id);
      // Save authoritative ownership before hard deletion; never derive it
      // from the actor because an administrator may act across projects.
      const policyOwners = new Set([resource?.projectId, record?.projectId, ...imported.map(item => item.projectId)].filter((owner): owner is string => Boolean(owner)));
      if (policyOwners.size > 1) {
        // Policy identity is represented in several tables. Legacy or
        // inconsistent rows must not allow one owner to delete another's data.
        throw new ConflictError("Policy ownership is inconsistent. Contact a platform administrator before deleting it.", "policy_owner_conflict");
      }
      const auditProjectId = policyOwners.size === 1 ? [...policyOwners][0]! : null;
      const name = resource?.definition.metadata.name ?? record?.name ?? String(imported[0]?.definition.name ?? input.id);
      // A Guardrail version is built from this Policy: its Policy versions must stay viewable.
      const versionUses = await tx.select({ name: guardrails.name, version: guardrailVersions.version }).from(guardrailVersions)
        .innerJoin(guardrails, eq(guardrails.id, guardrailVersions.guardrailId))
        .where(sql`${guardrailVersions.plan}->'policy_bindings' @> ${JSON.stringify([{ policy_id: input.id }])}::jsonb`).limit(5);
      if (versionUses.length) {
        throw new ConflictError(
          currentProjectId()
            ? `Policy ${name} is used by Guardrail versions. Delete those versions first.`
            : `Policy ${name} is used by Guardrail versions: ${versionUses.map((item) => `${item.name} ${item.version}`).join(", ")}. Delete those versions first.`,
          "policy_in_use",
        );
      }
      const activeGuardrails = await tx.select({ id: guardrails.id, name: guardrails.name, draftConfig: guardrails.draftConfig })
        .from(guardrails).where(isNull(guardrails.deletedAt));
      const referenced = activeGuardrails.filter((item) => normalizeGuardrailDraft(item.draftConfig).policyBindings.some((binding) => binding.policyId === input.id));
      if (referenced.length) {
        throw new ConflictError(
          `Policy ${name} is still referenced by Guardrail drafts.`,
          "policy_in_use",
        );
      }
      const profiles = await tx.select().from(guardrailProfiles);
      const profileUses = profiles.filter(profile => profile.definition.policies.some(binding => binding.policyId === input.id)
        || profile.definition.optionalPolicyIds.includes(input.id));
      if (profileUses.length) throw new ConflictError(
        currentProjectId()
          ? `Policy ${name} is still referenced by Profiles.`
          : `Policy ${name} is still referenced by Profiles: ${profileUses.map(profile => profile.definition.name).join(", ")}.`,
        "policy_in_use",
      );
      const [activeRun] = await tx.select({ id: policyResourceValidations.id }).from(policyResourceValidations)
        .where(and(eq(policyResourceValidations.policyId, input.id), inArray(policyResourceValidations.status, ["queued", "running"]))).limit(1);
      if (activeRun) throw new ConflictError("Wait for Policy testing to finish before deleting this Policy.", "policy_validation_in_progress");
      await tx.delete(outboxEvents).where(and(eq(outboxEvents.aggregateId, input.id), eq(outboxEvents.kind, "policy.validation_requested")));
      await tx.delete(policyResourceValidations).where(eq(policyResourceValidations.policyId, input.id));
      await tx.delete(policyResourceVersions).where(eq(policyResourceVersions.policyId, input.id));
      await tx.delete(policyResources).where(eq(policyResources.id, input.id));
      await tx.delete(policyImportedVersions).where(eq(policyImportedVersions.policyId, input.id));
      await tx.delete(policyRecords).where(eq(policyRecords.id, input.id));
      await tx.insert(auditEvents).values({
        id: randomUUID(), projectId: auditProjectId, kind: "policy.deleted", actorId: input.actorId,
        resourceType: "policy", resourceId: input.id, detail: { name },
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
    await assertResourceWriteAccess(this.db, "policy", input.id);
    if (!input.compilerAvailable) {
      throw new ConflictError("A healthy compiler Runner in the project runtime group is required to validate Policy drafts.", "default_runner_unavailable");
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
    await assertResourceReadAccess(this.db, "policy", id);
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
    await assertResourceWriteAccess(this.db, "policy", input.id);
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
    const rows = await this.db.select().from(guardrails).where(and(
      isNull(guardrails.deletedAt), resourceReadPredicate("guardrail", guardrails.id, guardrails.projectId),
    )).orderBy(desc(guardrails.updatedAt));
    const monthly = await this.pricing.monthlyCosts(rows.map(row => row.id));
    return Promise.all(rows.map(async row => ({ ...await this.guardrailSummary(row), monthlyCost: monthly.get(row.id)! })));
  }

  /** The Test Cases frozen into one version: part of its definition, read only. */
  async guardrailVersionTestSuite(guardrailId: string, version: string) {
    const [row] = await this.db.select({ testSuite: guardrailVersions.testSuite }).from(guardrailVersions)
      .innerJoin(guardrails, and(eq(guardrails.id, guardrailVersions.guardrailId), isNull(guardrails.deletedAt)))
      .where(and(eq(guardrailVersions.guardrailId, guardrailId), eq(guardrailVersions.version, version), resourceReadPredicate("guardrail", guardrails.id, guardrails.projectId)));
    if (!row) throw new NotFoundError("Guardrail version", `${guardrailId}@${version}`);
    const items = row.testSuite ?? [];
    return { guardrailId, version, recorded: row.testSuite !== null, digest: row.testSuite ? testSuiteDigest(row.testSuite) : null, items, count: items.length };
  }

  async getGuardrail(id: string) {
    const [guardrail] = await this.db.select().from(guardrails).where(and(
      eq(guardrails.id, id), isNull(guardrails.deletedAt), resourceReadPredicate("guardrail", guardrails.id, guardrails.projectId),
    ));
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
      resourceReadPredicate("guardrail", guardrails.id, guardrails.projectId),
    ));
    if (!guardrail) throw new NotFoundError("Guardrail", id);
    const candidateVersion = guardrailVersionId();
    const draft = normalizeGuardrailDraft(guardrail.draftConfig);
    const catalog = await this.catalogPolicies();
    const programmablePolicies = await this.resolveProgrammablePolicies(draft, catalog);
    const plan = buildGuardrailPlan({
      guardrailId: id,
      guardrailVersion: candidateVersion,
      draft,
      policies: catalog,
      programmablePolicies,
    });
    return {
      guardrailId: id,
      guardrailName: guardrail.name,
      draftRevision: guardrail.draftRevision,
      candidateVersion,
      runtimeProfile: guardrail.runtimeProfile,
      compilerVersion: String(plan.compiler_version ?? "tasklattice-controller-plan-v1"),
      plan,
    };
  }

  async previewGuardrailPlan(input: {
    draftConfig: GuardrailDraftConfig;
    runtimeProfile: string;
  }) {
    const draftConfig = normalizeGuardrailDraft(input.draftConfig);
    const { catalog, programmablePolicies } = await this.validateGuardrailDraft(draftConfig);
    const plan = buildGuardrailPlan({
      guardrailId: "draft-preview",
      guardrailVersion: guardrailVersionId(),
      draft: draftConfig,
      policies: catalog,
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
        version: "controller-plan-v1",
        flow: stepId,
        timeout_ms: typeof module?.timeout_ms === "number" ? module.timeout_ms : 0,
        failure_mode: typeof module?.failure_mode === "string" ? module.failure_mode : "fail_closed",
      };
    });
    return {
      guardrail_id: "",
      candidate_version: String(plan.guardrail_version),
      engine: "Guard Runner · NeMo",
      colang_version: input.runtimeProfile === "llmrails_colang1_standard" ? "1.0" : input.runtimeProfile === "llmrails_colang2_programmable" ? "2.x" : "auto",
      compiler_version: String(plan.compiler_version ?? "tasklattice-controller-plan-v1"),
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
    name: string; draftConfig: GuardrailDraftConfig; runtimeProfile: string; actorId: string; idempotencyKey?: string | undefined;
  }) {
    const draftConfig = normalizeGuardrailDraft(input.draftConfig);
    const creationKey = input.idempotencyKey ? `${input.actorId}:${input.idempotencyKey}` : null;
    const creationDigest = createHash("sha256").update(canonicalJson({ name: input.name, draftConfig, runtimeProfile: input.runtimeProfile })).digest("hex");
    const created = await this.db.transaction(async tx => {
      if (creationKey) {
        await advisoryTransactionLock(tx, `guardrail-create:${creationKey}`);
        const [existing] = await tx.select().from(guardrails).where(eq(guardrails.creationKey, creationKey));
        if (existing) {
          if (currentProjectId() && existing.projectId !== currentProjectId()) throw new NotFoundError("Guardrail", existing.id);
          if (existing.creationDigest !== creationDigest || existing.deletedAt)
            throw new ConflictError("This creation key belongs to another request or a deleted Guardrail.", "guardrail_creation_conflict");
          return existing;
        }
      }
      await this.validateGuardrailDraft(draftConfig, tx);
      return this.createGuardrailIn(tx, { ...input, draftConfig, creationKey, creationDigest });
    });
    return this.guardrailSummary(created);
  }

  private async createGuardrailIn(tx: Transaction, input: { platformPreset?: boolean; name: string; draftConfig: GuardrailDraftConfig; runtimeProfile: string; actorId: string | null; creationKey?: string | null; creationDigest?: string }) {
    const id = randomUUID();
    const [created] = await tx.insert(guardrails).values({ id, projectId: input.platformPreset ? null : projectOwnerForCreate(), name: input.name, draftConfig: input.draftConfig, runtimeProfile: input.runtimeProfile, creationKey: input.creationKey, creationDigest: input.creationDigest }).returning();
    if (!created) throw new Error("Guardrail creation did not return the stored resource.");
    await this.syncGeneratedTestCases(tx, id, input.draftConfig);
    await tx.insert(auditEvents).values({ id: randomUUID(), kind: "guardrail.created", actorId: input.actorId,
      resourceType: "guardrail", resourceId: id, detail: { name: input.name, profileOrigin: input.draftConfig.profileOrigin } });
    return created;
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
      const [source] = await tx.select().from(guardrails).where(and(
        eq(guardrails.id, input.id), isNull(guardrails.deletedAt),
        resourceReadPredicate("guardrail", guardrails.id, guardrails.projectId),
      )).for("share");
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
      await tx.insert(guardrails).values({ id: copiedId, projectId: projectOwnerForCreate(), name: input.name, draftConfig: snapshot.draftConfig, runtimeProfile: snapshot.runtimeProfile, loggingLevel: snapshot.loggingLevel as "info" | "debug" | "trace", excludedTestCaseIds: snapshot.excludedTestCaseIds, copyOrigin, duplicateKey });
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
    await assertResourceWriteAccess(this.db, "guardrail", input.id);
    const updated = await this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(guardrails).where(and(
        eq(guardrails.id, input.id), isNull(guardrails.deletedAt),
      )).for("update");
      if (!existing) throw new NotFoundError("Guardrail", input.id);
      if (input.expectedDraftRevision !== undefined && input.expectedDraftRevision !== existing.draftRevision) {
        throw new ConflictError("The draft changed while you were editing. Reload and review the latest changes before saving.", "guardrail_draft_conflict");
      }
      const draftConfig = input.draftConfig ? normalizeGuardrailDraft(input.draftConfig) : normalizeGuardrailDraft(existing.draftConfig);
      if (!draftConfig.profileOrigin && existing.draftConfig.profileOrigin) draftConfig.profileOrigin = existing.draftConfig.profileOrigin;
      await this.validateGuardrailDraft(draftConfig, tx, normalizeGuardrailDraft(existing.draftConfig));
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
      const [guardrail] = await tx.select().from(guardrails).where(and(eq(guardrails.id, id), isNull(guardrails.deletedAt), resourceReadPredicate("guardrail", guardrails.id, guardrails.projectId))).for("share");
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
      const [guardrail] = await tx.select().from(guardrails).where(and(eq(guardrails.id, input.id), isNull(guardrails.deletedAt), resourceWritePredicate(guardrails.projectId))).for("update");
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
    await assertResourceWriteAccess(this.db, "guardrail", input.guardrailId);
    // Freeze all publication inputs under the row lock; compilation does not
    // hold a database transaction or depend on any test outcome.
    const prepared = await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const [guardrail] = await tx.select().from(guardrails).where(and(
        eq(guardrails.id, input.guardrailId), isNull(guardrails.deletedAt),
      )).for("update");
      if (!guardrail) throw new NotFoundError("Guardrail", input.guardrailId);
      if (input.expectedDraftRevision !== undefined && input.expectedDraftRevision !== guardrail.draftRevision)
        throw new ConflictError("Guardrail draft changed. Review the current draft before publishing.", "guardrail_draft_conflict");
      if (currentProjectId()) await this.validateGuardrailDraft(normalizeGuardrailDraft(guardrail.draftConfig), tx);
      const [existing] = await tx.select({ version: guardrailVersions, artifact: artifacts }).from(guardrailVersions)
        .innerJoin(artifacts, eq(artifacts.id, guardrailVersions.artifactId)).where(and(
        eq(guardrailVersions.guardrailId, guardrail.id), eq(guardrailVersions.sourceDraftRevision, guardrail.draftRevision),
        eq(guardrailVersions.status, "ready"), eq(guardrailVersions.origin, "local"), isNotNull(guardrailVersions.artifactId),
      )).orderBy(desc(guardrailVersions.createdAt)).limit(1);
      if (existing && !artifactExecutionContractIssue(existing.artifact)) return { existing: existing.version };
      await assertGuardrailVersionCapacity(tx, guardrail.id, 1);
      // Reuse frozen executable content when available, including failed tests.
      const candidateColumns = getTableColumns(validationRuns);
      const [candidate] = await tx.select({ ...candidateColumns, ...validationSnapshotColumns }).from(validationRuns).where(and(
        eq(validationRuns.guardrailId, guardrail.id), eq(validationRuns.subject, "draft"),
        eq(validationRuns.sourceDraftRevision, guardrail.draftRevision),
        inArray(validationRuns.status, ["passed", "failed"]), isNotNull(validationSnapshotColumns.candidateArtifact),
      )).orderBy(desc(validationRuns.createdAt)).limit(1);
      if (candidate?.candidateArtifact && !artifactExecutionContractIssue(candidate.candidateArtifact)
        && candidate.candidateInspection && candidate.candidatePolicies && candidate.testSuite)
        return { guardrail, candidate };
      const draft = normalizeGuardrailDraft(guardrail.draftConfig);
      const catalog = await this.catalogPolicies(undefined, tx);
      const programmablePolicies = await this.resolveProgrammablePolicies(draft, catalog, tx);
      const rows = await tx.select().from(testCases).where(eq(testCases.guardrailId, guardrail.id));
      const suite = freezeTestSuite(applyValidationOverrides(rows, draft).filter(item => !guardrail.excludedTestCaseIds.includes(item.id)));
      const version = guardrailVersionId();
      const plan = buildGuardrailPlan({ guardrailId: guardrail.id, guardrailVersion: version, draft, policies: catalog, programmablePolicies });
      return { guardrail, compilation: { guardrailId: guardrail.id, guardrailVersion: version, runtimeProfile: guardrail.runtimeProfile, plan },
        candidate: { id: null, guardrailVersion: version, sourceDraftRevision: guardrail.draftRevision, candidateArtifact: null,
          candidateDigest: null, testSuite: suite,
          candidateInspection: guardrailInspection({ name: guardrail.name, runtimeProfile: guardrail.runtimeProfile, draftConfig: draft, catalog, programmablePolicies, testSuite: suite }),
          candidatePolicies: guardrailPolicyNodes(draft.policyBindings, catalog, programmablePolicies) } satisfies PublicationCandidate };
    });
    if (prepared.existing) return { guardrailId: input.guardrailId, version: prepared.existing.version,
      generation: prepared.existing.generation, status: prepared.existing.status, artifactId: prepared.existing.artifactId };
    const candidate: PublicationCandidate = prepared.candidate!;
    if (prepared.compilation) {
      if (!this.artifactCompiler) throw new ConflictError("Connect a compiler Runner to publish this draft. Tests are optional.", "guardrail_compiler_unavailable");
      const compiled = canonicalArtifactContent(await this.artifactCompiler(prepared.compilation), this.config.protoPath);
      if (compiled.guardrailId !== input.guardrailId || compiled.guardrailVersion !== candidate.guardrailVersion
        || canonicalJson(planToWire(compiled.plan)) !== canonicalJson(planToWire(prepared.compilation.plan))
        || !["", "auto", compiled.runtimeProfile].includes(prepared.compilation.runtimeProfile))
        throw new ConflictError("The compiled Artifact does not match the requested draft. Retry publication.", "guardrail_candidate_corrupt");
      candidate.candidateArtifact = compiled;
      candidate.candidateDigest = artifactContentDigest(compiled);
    }
    return this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const [guardrail] = await tx.select().from(guardrails).where(and(eq(guardrails.id, input.guardrailId), isNull(guardrails.deletedAt), resourceWritePredicate(guardrails.projectId))).for("update");
      if (!guardrail || guardrail.draftRevision !== candidate.sourceDraftRevision)
        throw new ConflictError("Guardrail draft changed during compilation. Review and publish the current draft.", "guardrail_draft_conflict");
      if (currentProjectId()) await this.validateGuardrailDraft(normalizeGuardrailDraft(guardrail.draftConfig), tx);
      // Concurrent/retried publication reuses only a current executable version.
      const [existing] = await tx.select({ version: guardrailVersions, artifact: artifacts }).from(guardrailVersions)
        .innerJoin(artifacts, eq(artifacts.id, guardrailVersions.artifactId)).where(and(
        eq(guardrailVersions.guardrailId, guardrail.id), eq(guardrailVersions.sourceDraftRevision, guardrail.draftRevision),
        eq(guardrailVersions.status, "ready"), eq(guardrailVersions.origin, "local"), isNotNull(guardrailVersions.artifactId),
      )).orderBy(desc(guardrailVersions.createdAt)).limit(1);
      if (existing && !artifactExecutionContractIssue(existing.artifact)) return { guardrailId: guardrail.id,
        version: existing.version.version, generation: existing.version.generation, status: existing.version.status, artifactId: existing.version.artifactId };
      return this.publishCandidate(tx, guardrail, candidate, input.actorId);
    });
  }

  async guardrailVersionDeletionImpact(guardrailId: string, version: string) {
    return this.db.transaction(async tx => {
      const { guardrail, record } = await this.loadGuardrailVersion(tx, guardrailId, version);
      return this.versionDeletionImpact(tx, guardrail, record);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  /** A version can be deleted once no routing references remain and Runners have stopped serving it. */
  async deleteGuardrailVersion(input: { guardrailId: string; version: string; actorId: string }) {
    await assertResourceWriteAccess(this.db, "guardrail", input.guardrailId);
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
      // Keep artifacts and telemetry; apply report retention after this version moves into unversioned history.
      await tx.delete(guardrailVersions).where(and(eq(guardrailVersions.guardrailId, input.guardrailId), eq(guardrailVersions.version, input.version)));
      await pruneTestingReports(tx, input.guardrailId);
      const [remaining] = await tx.select({ version: guardrailVersions.version }).from(guardrailVersions)
        .where(and(eq(guardrailVersions.guardrailId, input.guardrailId), eq(guardrailVersions.status, "ready"))).limit(1);
      if (!remaining) {
        const [state] = await tx.update(controllerState).set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
          .where(eq(controllerState.id, "singleton")).returning();
        if (!state) throw new Error("Controller state is not initialized.");
        await tx.update(guardrails).set({ status: "draft", ...resetProtectionMode, protectionModeGeneration: state.desiredGeneration, desiredGeneration: state.desiredGeneration, updatedAt: new Date() }).where(eq(guardrails.id, input.guardrailId));
        await tx.insert(outboxEvents).values({ id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: input.guardrailId, payload: { guardrailId: input.guardrailId } });
      }
    });
  }

  private async loadGuardrailVersion(tx: Transaction, guardrailId: string, version: string, lock = false) {
    const query = tx.select().from(guardrails).where(and(eq(guardrails.id, guardrailId), isNull(guardrails.deletedAt), lock ? resourceWritePredicate(guardrails.projectId) : resourceReadPredicate("guardrail", guardrails.id, guardrails.projectId)));
    const [guardrail] = lock ? await query.for("update") : await query;
    if (!guardrail) throw new NotFoundError("Guardrail", guardrailId);
    const [record] = await tx.select().from(guardrailVersions).where(and(eq(guardrailVersions.guardrailId, guardrailId), eq(guardrailVersions.version, version)));
    if (!record) throw new NotFoundError("Guardrail version", version);
    return { guardrail, record };
  }

  private async versionDeletionImpact(tx: Transaction, guardrail: typeof guardrails.$inferSelect, record: typeof guardrailVersions.$inferSelect): Promise<GuardrailVersionDeletionImpact> {
    const routing = await this.trafficRouting.versionReferences(guardrail.id, record.version, tx);
    const references = routing.references;
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
        const runners = await tx.select({ ...getTableColumns(runnerInstances) }).from(runnerInstances)
          .innerJoin(runnerPools, eq(runnerPools.id, runnerInstances.poolId))
          .where(sql`exists (select 1 from ${projects}
            where ${projectPoolAllocation} and ${projects.id} = ${guardrail.projectId})`);
        const online = runners.filter(r => r.lastHeartbeatAt && Date.now() - r.lastHeartbeatAt.getTime() < 60_000);
        if (online.some(r => r.appliedGeneration < generation)) blockers.push({ code: "runner_sync" });
      }
    }
    return { guardrailId: guardrail.id, version: record.version, deletable: !references.length && !blockers.length, references, blockers, unrestorableRevisions: routing.historical };
  }

  async listTestCases(guardrailId: string) {
    const [guardrail] = await this.db.select({ excludedTestCaseIds: guardrails.excludedTestCaseIds,
      draftConfig: guardrails.draftConfig })
      .from(guardrails).where(and(
        eq(guardrails.id, guardrailId), isNull(guardrails.deletedAt),
        resourceReadPredicate("guardrail", guardrails.id, guardrails.projectId),
      ));
    if (!guardrail) throw new NotFoundError("Guardrail", guardrailId);
    const excluded = new Set(guardrail.excludedTestCaseIds);
    // Test cases belong to this Guardrail. Its read predicate above is the
    // complete authority; source Policy snapshots are not a second gate.
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
    await assertResourceWriteAccess(this.db, "guardrail", input.guardrailId);
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
    await assertResourceWriteAccess(this.db, "guardrail", input.guardrailId);
    await this.db.transaction(async (tx) => {
      const [guardrail] = await tx.select().from(guardrails).where(and(eq(guardrails.id, input.guardrailId), isNull(guardrails.deletedAt), resourceWritePredicate(guardrails.projectId))).for("update");
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
    await assertResourceWriteAccess(this.db, "guardrail", input.guardrailId);
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

  async queryValidationRuns(query: z.input<typeof testingReportsQuery>) {
    if (query.guardrailId) await assertResourceReadAccess(this.db, "guardrail", query.guardrailId);
    return queryTestingReports(this.db, query);
  }

  async listValidationRuns(guardrailId?: string | undefined) {
    return (await this.queryValidationRuns({ guardrailId })).items;
  }

  async authorizeReportRead(runId: string): Promise<void> {
    const [guardrailRun] = await this.db.select({ id: validationRuns.id }).from(validationRuns).where(eq(validationRuns.id, runId));
    if (guardrailRun) { await this.getValidationRun(runId); return; }
    const [resourceRun] = await this.db.select({ policyId: policyResourceValidations.policyId }).from(policyResourceValidations).where(eq(policyResourceValidations.id, runId));
    const [programmableRun] = resourceRun ? [] : await this.db.select({ policyId: policyValidationRuns.policyId }).from(policyValidationRuns).where(eq(policyValidationRuns.id, runId));
    const policyId = resourceRun?.policyId ?? programmableRun?.policyId;
    if (!policyId) throw new NotFoundError("Testing Report", runId);
    await assertResourceReadAccess(this.db, "policy", policyId);
  }

  async validationReportTerminal(runId: string): Promise<boolean> {
    const { rows: [run] } = await this.db.execute<{ status: string }>(sql`SELECT status FROM validation_report_state WHERE id=${runId}`);
    return Boolean(run && !["queued", "running"].includes(run.status));
  }

  async getValidationRun(id: string): Promise<Omit<typeof validationRuns.$inferSelect, "snapshotDigest"> & { cancellation?: { requestedAt: Date; acknowledgedAt: Date | null } }> {
    const [run] = await this.db.select(validationSummaryColumns)
      .from(validationRuns).where(eq(validationRuns.id, id));
    if (!run) throw new NotFoundError("Validation Run", id);
    await assertResourceReadAccess(this.db, "guardrail", run.guardrailId);
    if (run.status === "cancelled") {
      const [delivery] = await this.db.select({ requestedAt: outboxEvents.createdAt, acknowledgedAt: outboxEvents.processedAt })
        .from(outboxEvents).where(eq(outboxEvents.id, `cancel-${id}`));
      return { ...run, ...(delivery ? { cancellation: delivery } : {}) };
    }
    return run;
  }

  /** Cancellation intent and delivery are durable; late results cannot undo it. */
  async cancelValidation(input: { runId: string; actorId: string }) {
    return this.db.transaction(async tx => {
      const [found] = await tx.select(validationSummaryColumns).from(validationRuns).where(eq(validationRuns.id, input.runId));
      if (!found) throw new NotFoundError("Testing Report", input.runId);
      const [guardrail] = await tx.select({ id: guardrails.id }).from(guardrails).where(and(eq(guardrails.id, found.guardrailId), resourceWritePredicate(guardrails.projectId))).for("update");
      if (!guardrail) throw new NotFoundError("Guardrail", found.guardrailId);
      const [run] = await tx.select(validationSummaryColumns).from(validationRuns).where(eq(validationRuns.id, input.runId)).for("update");
      if (!run) throw new NotFoundError("Testing Report", input.runId);
      if (run.status !== "queued" && run.status !== "running") return publicValidationRun(run);
      const [cancelled] = await tx.update(validationRuns).set({ status: "cancelled", completedAt: new Date(),
        failureReason: "Cancelled by user." }).where(eq(validationRuns.id, run.id)).returning(validationSummaryColumns);
      await tx.update(outboxEvents).set({ processedAt: new Date() }).where(eq(outboxEvents.id, run.id));
      await tx.insert(outboxEvents).values({ id: `cancel-${run.id}`, kind: "guardrail.validation_cancel_requested",
        aggregateId: run.guardrailId, payload: { runId: run.id } });
      await tx.insert(auditEvents).values({ id: randomUUID(), kind: "guardrail.validation_cancelled", actorId: input.actorId,
        resourceType: "guardrail", resourceId: run.guardrailId, detail: { runId: run.id, previousStatus: run.status } });
      return publicValidationRun(cancelled!);
    });
  }

  async testingReportDeletionImpact(runId: string) {
    const [run] = await this.db.select({ id: validationRuns.id, guardrailId: validationRuns.guardrailId,
      guardrailVersion: validationRuns.guardrailVersion, status: validationRuns.status })
      .from(validationRuns).where(eq(validationRuns.id, runId));
    if (!run) throw new NotFoundError("Testing Report", runId);
    await assertResourceReadAccess(this.db, "guardrail", run.guardrailId);
    return this.reportDeletionImpact(run);
  }

  async deleteTestingReport(input: { runId: string; actorId: string }) {
    return this.db.transaction(async tx => {
      const [found] = await tx.select(validationSummaryColumns).from(validationRuns).where(eq(validationRuns.id, input.runId));
      if (!found) throw new NotFoundError("Testing Report", input.runId);
      // Serialize with publication, release, other report deletions and Router references.
      const [guardrail] = await tx.select().from(guardrails).where(and(eq(guardrails.id, found.guardrailId), resourceWritePredicate(guardrails.projectId))).for("update");
      if (!guardrail) throw new NotFoundError("Guardrail", found.guardrailId);
      const [run] = await tx.select(validationSummaryColumns).from(validationRuns).where(eq(validationRuns.id, input.runId)).for("update");
      if (!run) throw new NotFoundError("Testing Report", input.runId);
      const impact = this.reportDeletionImpact(run);
      if (!impact.deletable) throw new ConflictError("Wait for this test to finish before deleting its report.",
        "test_report_in_use", { impact });
      await tx.update(guardrailVersions).set({ validationRunId: null })
        .where(and(eq(guardrailVersions.guardrailId, run.guardrailId), eq(guardrailVersions.validationRunId, run.id)));
      await tx.delete(outboxEvents).where(and(eq(outboxEvents.id, run.id), eq(outboxEvents.kind, "guardrail.validation_requested")));
      await tx.delete(validationRuns).where(eq(validationRuns.id, run.id));
      await tx.insert(auditEvents).values({ id: randomUUID(), kind: "guardrail.testing_report_deleted", actorId: input.actorId,
        resourceType: "guardrail", resourceId: run.guardrailId,
        detail: { runId: run.id, version: run.guardrailVersion, status: run.status, subject: run.subject,
          contentDigest: run.candidateDigest, testSuiteDigest: run.testSuiteDigest } });
      return impact;
    });
  }

  private reportDeletionImpact(run: Pick<typeof validationRuns.$inferSelect, "id" | "guardrailId" | "guardrailVersion" | "status">): TestingReportDeletionImpact {
    const running = run.status === "queued" || run.status === "running";
    return { runId: run.id, guardrailId: run.guardrailId, version: run.guardrailVersion, running,
      deletable: !running };
  }

  async requestValidation(input: { guardrailId: string; actorId: string; compilerAvailable: boolean; testModelRules?: boolean }) {
    await assertResourceWriteAccess(this.db, "guardrail", input.guardrailId);
    if (!input.compilerAvailable) {
      throw new ConflictError("A healthy compiler Runner in the project runtime group is required to validate Guardrail configurations.", "default_runner_unavailable");
    }
    return this.db.transaction(async (tx) => {
      const [guardrail] = await tx.select().from(guardrails).where(and(
        eq(guardrails.id, input.guardrailId), isNull(guardrails.deletedAt),
      )).for("update");
      if (!guardrail) throw new NotFoundError("Guardrail", input.guardrailId);
      return this.enqueueGuardrailValidation(tx, guardrail, input.actorId, input.testModelRules ?? true);
    });
  }

  /**
   * Test an existing version in this environment: its own frozen suite against
   * its signed Artifact, as it is. Nothing is compiled; the run records which
   * content and which suite it tested, independently of publication.
   */
  async requestVersionTestRun(input: { guardrailId: string; version: string; actorId: string; testModelRules?: boolean }) {
    return this.db.transaction(async tx => {
      const [guardrail] = await tx.select().from(guardrails).where(and(eq(guardrails.id, input.guardrailId), isNull(guardrails.deletedAt), resourceWritePredicate(guardrails.projectId))).for("update");
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
        testModelRules: input.testModelRules ?? true, subject: "version", status: "queued", metrics: emptyValidationMetrics(version.testSuite.length), excludedCaseIds: [],
        // Freeze the content and suite under test.
        candidateDigest: artifact.checksum, snapshotDigest: await storeValidationSnapshot(tx, { candidateArtifact: null, candidateInspection: version.inspection, candidatePolicies: version.policies, testSuite: version.testSuite }),
        testSuiteDigest: testSuiteDigest(version.testSuite), createdBy: input.actorId,
      });
      await tx.insert(outboxEvents).values({
        id: runId, kind: "guardrail.validation_requested", aggregateId: input.guardrailId,
        payload: {
          runId, guardrailId: input.guardrailId, candidateVersion: input.version, sourceDraftRevision: version.sourceDraftRevision,
          runtimeProfile: version.runtimeProfile, testCases: version.testSuite, artifact, testModelRules: input.testModelRules ?? true,
        },
      });
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.version_test_requested", actorId: input.actorId,
        resourceType: "guardrail", resourceId: input.guardrailId,
        detail: { runId, version: input.version, contentDigest: artifact.checksum, testCaseCount: version.testSuite.length, testModelRules: input.testModelRules ?? true },
      });
      return publicValidationRun((await tx.select().from(validationRuns).where(eq(validationRuns.id, runId)))[0]!);
    });
  }

  /** Publish an imported version without changing its content or test results. */
  async releaseGuardrailVersion(input: { guardrailId: string; version: string; actorId: string }) {
    return this.db.transaction(async tx => {
      const [guardrail] = await tx.select().from(guardrails).where(and(eq(guardrails.id, input.guardrailId), isNull(guardrails.deletedAt), resourceWritePredicate(guardrails.projectId))).for("update");
      if (!guardrail) throw new NotFoundError("Guardrail", input.guardrailId);
      const [version] = await tx.select().from(guardrailVersions).where(and(
        eq(guardrailVersions.guardrailId, input.guardrailId), eq(guardrailVersions.version, input.version))).for("update");
      if (!version) throw new NotFoundError("Guardrail version", `${input.guardrailId}@${input.version}`);
      if (version.status === "ready") return version;
      const [artifact] = version.artifactId ? await tx.select().from(artifacts).where(eq(artifacts.id, version.artifactId)) : [];
      if (!artifact) throw new ConflictError("This version has no Artifact to publish.", "guardrail_version_artifact_missing");
      const [state] = await tx.update(controllerState).set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton")).returning();
      if (!state) throw new Error("Controller state is not initialized.");
      const [released] = await tx.update(guardrailVersions).set({ status: "ready", releasedAt: new Date(), releasedBy: input.actorId,
        publication: { source: "user", actorId: input.actorId, createdAt: new Date().toISOString() } })
        .where(and(eq(guardrailVersions.guardrailId, input.guardrailId), eq(guardrailVersions.version, input.version))).returning();
      await tx.update(guardrails).set({ status: "active", updatedAt: new Date() })
        .where(and(eq(guardrails.id, input.guardrailId), eq(guardrails.status, "draft")));
      await tx.insert(outboxEvents).values({
        id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: input.guardrailId,
        payload: { guardrailId: input.guardrailId, version: input.version, generation: state.desiredGeneration, released: true },
      });
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.version_released", actorId: input.actorId, resourceType: "guardrail", resourceId: input.guardrailId,
        detail: { version: input.version, contentDigest: artifact.checksum, origin: version.origin, testsRequired: false },
      });
      return released!;
    });
  }

  /** Queues ordinary draft validation, including model checks. */
  private async enqueueGuardrailValidation(
    tx: Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0],
    guardrail: typeof guardrails.$inferSelect,
    actorId: string | null,
    testModelRules = true,
  ) {
      const rows = await tx.select().from(testCases).where(eq(testCases.guardrailId, guardrail.id));
      const excluded = new Set(guardrail.excludedTestCaseIds);
      const activeCases = applyValidationOverrides(rows, guardrail.draftConfig).filter((item) => !excluded.has(item.id));
      if (!activeCases.length) throw new ValidationError("Add at least one reviewed Test Case before running Validation.");
      // The run executes exactly this frozen suite; publishing copies it onto the version.
      const testSuite = freezeTestSuite(activeCases);
      const requestedAt = new Date();
      const candidateVersion = guardrailVersionId(requestedAt);
      const catalog = await this.catalogPolicies(undefined, tx);
      const programmablePolicies = await this.resolveProgrammablePolicies(normalizeGuardrailDraft(guardrail.draftConfig), catalog, tx);
      const plan = buildGuardrailPlan({
        guardrailId: guardrail.id,
        guardrailVersion: candidateVersion,
        draft: normalizeGuardrailDraft(guardrail.draftConfig),
        policies: catalog,
        programmablePolicies,
      });
      const runId = `testing-report-${randomUUID()}`;
      const inspection = guardrailInspection({
        name: guardrail.name, runtimeProfile: guardrail.runtimeProfile, draftConfig: normalizeGuardrailDraft(guardrail.draftConfig),
        catalog, programmablePolicies, testSuite,
      });
      // The Policy versions the candidate is built from, before any per-binding
      // expansion: the nodes a release package carries with this version.
      const policies = guardrailPolicyNodes(normalizeGuardrailDraft(guardrail.draftConfig).policyBindings, catalog, programmablePolicies);
      await tx.insert(validationRuns).values({
        id: runId,
        guardrailId: guardrail.id,
        guardrailVersion: candidateVersion,
        sourceDraftRevision: guardrail.draftRevision,
        status: "queued",
        testModelRules,
        metrics: emptyValidationMetrics(activeCases.length),
        excludedCaseIds: [...excluded],
        snapshotDigest: await storeValidationSnapshot(tx, { candidateArtifact: null, candidateInspection: inspection, candidatePolicies: policies, testSuite }),
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
          testModelRules,
        },
      });
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.validation_requested", actorId,
        resourceType: "guardrail", resourceId: guardrail.id,
        detail: { runId, sourceDraftRevision: guardrail.draftRevision, testCaseCount: activeCases.length, testModelRules },
      });
      return publicValidationRun((await tx.select().from(validationRuns).where(eq(validationRuns.id, runId)))[0]!);
  }

  async markValidationRunning(runId: string): Promise<boolean> {
    if (runId.startsWith("policy-job-") && await this.policyResources.running(runId)) return true;
    const policyUpdate = await this.db.update(policyValidationRuns).set({ status: "running" })
      .where(and(eq(policyValidationRuns.id, runId), eq(policyValidationRuns.status, "queued"))).returning({ id: policyValidationRuns.id });
    if (policyUpdate.length) return true;
    const [policyRun] = await this.db.select({ status: policyValidationRuns.status }).from(policyValidationRuns)
      .where(eq(policyValidationRuns.id, runId));
    if (policyRun) return policyRun.status === "running";
    const updated = await this.db.update(validationRuns).set({ status: "running" })
      .where(and(eq(validationRuns.id, runId), inArray(validationRuns.status, ["queued", "running"])))
      .returning({ id: validationRuns.id });
    return updated.length > 0;
  }

  async updateValidationProgress(runId: string, observation: Omit<ValidationProgress, "updatedAt">): Promise<void> {
    await this.db.transaction(async tx => {
      await limitValidationWrite(tx);
      const [run] = await tx.select({ status: validationRuns.status, progress: validationRuns.progress, metrics: validationRuns.metrics })
        .from(validationRuns).where(eq(validationRuns.id, runId)).for("update");
      // Policy tests use their own report contract; old/finished runs ignore late observations.
      if (!run || (run.status !== "queued" && run.status !== "running")) return;
      const progress = { ...observation, updatedAt: new Date().toISOString() };
      if (!advancesValidationProgress(run.progress, progress, run.metrics.total)) return;
      await tx.update(validationRuns).set({ status: "running", progress }).where(eq(validationRuns.id, runId));
    });
  }

  async completeValidation(input: {
    runId: string;
    upload?: ReportUploadIdentity;
    status: ValidationTerminalState;
    metrics: ValidationMetrics;
    reason?: string | undefined;
    candidateArtifact?: ArtifactContent | undefined;
    runtime?: ValidationRuntimeFingerprint | undefined;
    testScope?: import("../../shared/validation-scope.js").ValidationTestScope;
  }): Promise<void> {
    const existing = this.reportSaves.get(input.runId);
    if (existing) return existing;
    const job = (async () => {
      await withReportSaveDiagnostics(this.db, input.runId, () => this.persistValidation(input));
      const [run] = await this.db.select({ guardrailId: validationRuns.guardrailId }).from(validationRuns).where(eq(validationRuns.id, input.runId));
      if (run) this.queueReportPrune(run.guardrailId);
    })();
    this.reportSaves.set(input.runId, job);
    try { await this.reportJobs.track(job); }
    finally { if (this.reportSaves.get(input.runId) === job) this.reportSaves.delete(input.runId); }
  }

  private async persistValidation(input: Parameters<ControlPlaneService["completeValidation"]>[0]): Promise<void> {
    if (input.runId.startsWith("policy-job-") && await this.policyResources.complete(input)) return;
    const [policyRun] = await reportSaveStage("lookup_policy_run", () => this.db.select({ id: policyValidationRuns.id }).from(policyValidationRuns).where(eq(policyValidationRuns.id, input.runId)));
    if (policyRun) {
      await this.db.transaction(async (tx) => {
        await reportSaveStage("set_timeouts", () => limitValidationWrite(tx));
        const [locked] = await reportSaveStage("lock_run", () => tx.select({ id: policyValidationRuns.id, status: policyValidationRuns.status, policyId: policyValidationRuns.policyId }).from(policyValidationRuns)
          .where(eq(policyValidationRuns.id, input.runId)).for("update"));
        if (!locked || (locked.status !== "queued" && locked.status !== "running")) return;
        await this.reportResults.assertUpload(tx, input.runId, input.upload);
        const results = await this.reportResults.evidence(tx,input.runId);
        await reportSaveStage("write_report", () => tx.update(policyValidationRuns).set({
          status: input.status,
          failureReason: input.reason ?? null,
          completedAt: new Date(),
        }).where(eq(policyValidationRuns.id, input.runId)));
        await reportSaveStage("complete_outbox", () => tx.update(outboxEvents).set({ processedAt: new Date() }).where(eq(outboxEvents.id, input.runId)));
        await reportSaveStage("write_audit", () => tx.insert(auditEvents).values({
          id: randomUUID(), kind: "policy.validation_completed", actorId: null,
          resourceType: "policy", resourceId: locked.policyId,
          detail: { runId: input.runId, status: input.status, passed: results.filter((item) => item.passed).length, total: results.length },
        }));
      });
      return;
    }
    const [preparation] = await this.db.select({ id: validationRuns.id, guardrailId: validationRuns.guardrailId, guardrailVersion: validationRuns.guardrailVersion, subject: validationRuns.subject, status: validationRuns.status }).from(validationRuns).where(eq(validationRuns.id, input.runId));
    if (!preparation || !["queued", "running"].includes(preparation.status)) return;
    const prepared = preparation.subject === "draft" && (input.status === "passed" || input.candidateArtifact)
      ? await reportSaveStage("verify_candidate", () => this.verifiedCandidate(this.db, preparation, input.candidateArtifact))
      : { status: input.status, reason: input.reason ?? null };
    await this.db.transaction(async (tx) => {
      await reportSaveStage("set_timeouts", () => limitValidationWrite(tx));
      const [found] = await reportSaveStage("lookup_run", () => tx.select({ guardrailId: validationRuns.guardrailId }).from(validationRuns).where(eq(validationRuns.id, input.runId)));
      if (!found) return;
      // Same lock order as publication, report deletion and retention; completions serialize per Guardrail.
      const [guardrail] = await reportSaveStage("lock_guardrail", () => tx.select({ id: guardrails.id }).from(guardrails).where(and(eq(guardrails.id, found.guardrailId), resourceWritePredicate(guardrails.projectId))).for("update"));
      if (!guardrail) return;
      // Do not reload previous results, compiled content or policy snapshots
      // while holding the Guardrail lock; only the frozen suite is needed.
      const [run] = await reportSaveStage("lock_run", () => tx.select({ id: validationRuns.id, guardrailId: validationRuns.guardrailId,
        guardrailVersion: validationRuns.guardrailVersion, status: validationRuns.status, subject: validationRuns.subject,
        testModelRules: validationRuns.testModelRules, testSuite: validationSnapshotColumns.testSuite,
        candidateInspection: validationSnapshotColumns.candidateInspection, candidatePolicies: validationSnapshotColumns.candidatePolicies,
      }).from(validationRuns).where(eq(validationRuns.id, input.runId)).for("update"));
      // A deleted Guardrail may still have an in-flight Runner response. Acknowledge it without recreating data.
      if (!run) return;
      if (run.status !== "queued" && run.status !== "running") return;
      await this.reportResults.assertUpload(tx, input.runId, input.upload);
      // A version run tested an existing signed Artifact; there is no candidate to bind.
      const candidate = prepared;
      const evidence = await this.reportResults.evidence(tx, input.runId);
      const scopeError = await reportSaveStage("validate_scope", () => validateTestScope(run, { ...input, results: evidence }));
      const finalStatus = input.status === "failed" || scopeError ? "failed" : candidate.status;
      await reportSaveStage("write_report", async () => tx.update(validationRuns).set({
        status: finalStatus,
        metrics: input.metrics,
        failureReason: scopeError ?? candidate.reason ?? input.reason ?? null,
        testScope: input.testScope ?? null,
        completedAt: new Date(),
        runtimeFingerprint: input.runtime ?? null,
        ...("artifact" in candidate ? { snapshotDigest: await storeValidationSnapshot(tx, { candidateArtifact: candidate.artifact, candidateInspection: run.candidateInspection, candidatePolicies: run.candidatePolicies, testSuite: run.testSuite }), candidateDigest: candidate.digest } : {}),
      }).where(eq(validationRuns.id, input.runId)));
      await reportSaveStage("complete_outbox", () => tx.update(outboxEvents).set({ processedAt: new Date() }).where(eq(outboxEvents.id, input.runId)));
      await reportSaveStage("write_audit", () => tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail.validation_completed", actorId: null,
        resourceType: "guardrail", resourceId: run.guardrailId,
        detail: { runId: input.runId, status: finalStatus, testModelRules: run.testModelRules, testScope: input.testScope ?? null, complianceRate: input.metrics.complianceRate, ...("digest" in candidate ? { candidateDigest: candidate.digest } : {}) },
      }));

    });
    // Reconcile after committing the result. Initialization is idempotent and
    // will re-check the current revision/customization before requesting a
    // compile; a late result must never publish a newer, untested draft.
  }

  /**
   * A passed run is only evidence for content it actually executed. Bind the
   * returned candidate to the exact request (Guardrail, version, executable
   * plan and runtime profile); anything else turns the run into a failure.
   */
  private async verifiedCandidate(
    tx: Transaction | ControllerDatabase,
    run: Pick<typeof validationRuns.$inferSelect, "id" | "guardrailId" | "guardrailVersion">,
    returned: ArtifactContent | undefined,
  ): Promise<{ status: "passed"; reason: null; artifact: ArtifactContent; digest: string } | { status: "failed"; reason: string }> {
    if (!returned) return { status: "failed", reason: "The Runner did not return the tested Artifact. Upgrade the Runner and run tests again." };
    const [request] = await reportSaveStage("load_candidate_request", () => tx.select({
      plan: sql<Record<string, unknown>>`${outboxEvents.payload}->'plan'`,
      runtimeProfile: sql<string>`${outboxEvents.payload}->>'runtimeProfile'`,
    }).from(outboxEvents).where(and(
      eq(outboxEvents.id, run.id), eq(outboxEvents.kind, "guardrail.validation_requested"),
    )).limit(1));
    const plan = request?.plan;
    const profile = request?.runtimeProfile;
    // Keep exactly what a Runner decodes, so every environment computes one digest.
    const artifact = await reportSaveStage("normalize_candidate", () => canonicalArtifactContent(artifactContent(returned), this.config.protoPath));
    if (artifact.guardrailId !== run.guardrailId || artifact.guardrailVersion !== run.guardrailVersion
      || !plan || typeof plan !== "object" || Array.isArray(plan)
      || canonicalJson(planToWire(artifact.plan)) !== canonicalJson(planToWire(plan as Record<string, unknown>))
      || !["", "auto", artifact.runtimeProfile].includes(String(profile ?? ""))) {
      return { status: "failed", reason: "The tested Artifact does not match the requested candidate. Run tests again." };
    }
    const digest = await reportSaveStage("digest_candidate", () => artifactContentDigest(artifact));
    return { status: "passed", reason: null, artifact, digest };
  }

  /**
   * Publish frozen compiled content, signed by this environment. Tests and
   * deployment readiness are independent of this publication record.
   */
  private async publishCandidate(
    tx: Transaction,
    guardrail: typeof guardrails.$inferSelect,
    run: PublicationCandidate,
    actorId: string | null,
  ) {
    await assertGuardrailVersionCapacity(tx, guardrail.id, 1);
    const candidate = run.candidateArtifact;
    if (!candidate || !run.candidateDigest || !run.candidateInspection || !run.candidatePolicies || !run.testSuite
      || testSuiteDigest(run.testSuite) !== run.candidateInspection.testSuite.digest) {
      throw new ConflictError(
        "The compiled publication is incomplete. Retry publication.",
        "guardrail_compilation_failed",
        { draftRevision: guardrail.draftRevision },
      );
    }
    const content = artifactContent(candidate);
    const contractIssue = artifactExecutionContractIssue(content);
    if (contractIssue) throw new ConflictError(contractIssue, "artifact_recompile_required");
    const checksum = artifactContentDigest(content);
    if (checksum !== run.candidateDigest) throw new ConflictError("The compiled Artifact no longer matches its digest.", "guardrail_candidate_corrupt");
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
      policies: run.candidatePolicies,
      testSuite: run.testSuite,
      // Release records a publication decision, independently of test results.
      publication: { source: actorId ? "user" : "deployment", actorId, createdAt: new Date().toISOString() },
      releasedAt: new Date(),
      releasedBy: actorId,
      createdBy: actorId,
    });
    await tx.update(guardrails).set({
      status: "active",
      desiredGeneration: state.desiredGeneration,
      updatedAt: new Date(),
    }).where(eq(guardrails.id, guardrail.id));
    await tx.insert(outboxEvents).values({
      id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: guardrail.id,
      payload: { guardrailId: guardrail.id, version: run.guardrailVersion, generation: state.desiredGeneration, artifactId: stored.id },
    });
    await tx.insert(auditEvents).values({
      id: randomUUID(), kind: "guardrail.published", actorId,
      resourceType: "guardrail", resourceId: guardrail.id,
      detail: { version: run.guardrailVersion, generation: state.desiredGeneration, artifactId: stored.id, contentDigest: checksum, validationRunId: run.id },
    });
    return { guardrailId: guardrail.id, version: run.guardrailVersion, generation: state.desiredGeneration, status: "ready" as const, artifactId: stored.id };
  }

  async rejectValidation(input: { runId: string; reason: string }): Promise<void> {
    if (input.runId.startsWith("policy-job-") && await this.policyResources.complete({ ...input, status: "failed", executionFailed: true })) return;
    const [policyRun] = await this.db.select().from(policyValidationRuns).where(eq(policyValidationRuns.id, input.runId));
    if (policyRun) {
      await this.completeValidation({
        runId: input.runId,
        status: "failed",
        metrics: emptyValidationMetrics(0),
        reason: input.reason,
      });
      return;
    }
    const [run] = await this.db.select(validationSummaryColumns).from(validationRuns).where(eq(validationRuns.id, input.runId));
    // A deleted Guardrail may still have an in-flight Runner response. Acknowledge it without recreating data.
      if (!run) return;
    await this.completeValidation({
      runId: input.runId,
      status: "failed",
      metrics: run.metrics,
      reason: input.reason,
    });
  }

  async guardrailLogging(id: string) {
    const [guardrail] = await this.db.select({ id: guardrails.id, level: guardrails.loggingLevel, updatedAt: guardrails.updatedAt })
      .from(guardrails).where(and(
        eq(guardrails.id, id), isNull(guardrails.deletedAt),
        resourceReadPredicate("guardrail", guardrails.id, guardrails.projectId),
      ));
    if (!guardrail) throw new NotFoundError("Guardrail", id);
    return { ...guardrail, contentCaptureEnabled: this.runtimeLogEncryptionKey !== null, retentionDays: 30 };
  }

  async updateGuardrailLogging(input: { id: string; level: "info" | "debug" | "trace"; actorId: string }) {
    await assertResourceWriteAccess(this.db, "guardrail", input.id);
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
      .where(and(isNull(endpoints.deletedAt), resourceReadPredicate("endpoint", endpoints.id, endpoints.projectId)))
      .orderBy(desc(endpoints.updatedAt));
    return rows.map((endpoint) => this.publicEndpoint(endpoint));
  }

  async getEndpoint(id: string) {
    const [endpoint] = await this.db.select().from(endpoints)
      .where(and(eq(endpoints.id, id), isNull(endpoints.deletedAt), resourceReadPredicate("endpoint", endpoints.id, endpoints.projectId)));
    if (!endpoint) throw new NotFoundError("Endpoint", id);
    return this.publicEndpoint(endpoint);
  }

  async verifyScanTestCredential(id: string, credential: string) {
    const [endpoint] = await this.db.select().from(endpoints)
      .where(and(eq(endpoints.id, id), isNull(endpoints.deletedAt)));
    const digest = createHash("sha256").update(credential).digest("hex");
    if (!endpoint || endpoint.adapter !== "f5-scan" || endpoint.status !== "active" ||
        !activeEndpointCredentials(endpoint.verification).some(item => item.sha256 === digest)) {
      throw new ValidationError("Use an active API key belonging to the selected Scan Endpoint.");
    }
  }

  async listRuntimeEvents(limit = 100) {
    return (await this.queryRuntimeEvents({ limit })).items;
  }

  async querySecurityEvents(query: SecurityEventsQuery) {
    return querySecurityEvents(this.db, query);
  }

  private metricCache = new Map<string, { until: number; value: Awaited<ReturnType<typeof queryRuntimeMetrics>> }>();
  private metricJobs = new Map<string, ReturnType<typeof queryRuntimeMetrics>>();
  async runtimeMetrics(scope: MetricScope) {
    // Grants may be revoked between reads; project resource visibility stays live.
    if (currentProjectId()) return queryRuntimeMetrics(this.db, scope);
    const key = JSON.stringify([currentProjectId(), scope.window, scope.guardrailId ?? null, scope.routerId ?? null]);
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
      const { allocationContextId: _allocationContextId, ...visible } = event;
      return visible;
    }
    // Exclude large bodies in SQL, before the database driver allocates them in Node.
    const metadata = includeContent ? runtimeEvents.metadata : sql<Record<string, unknown>>`(${runtimeEvents.metadata} - 'contentCiphertext' - 'contentBefore' - 'contentAfter' - 'httpRequest' - 'modelExchanges') || jsonb_build_object('contentAvailable',
      (${this.runtimeLogEncryptionKey !== null} AND coalesce(${runtimeEvents.metadata}->>'contentCiphertext', '') <> '')
      OR ${runtimeEvents.metadata}->'contentBefore' IS NOT NULL AND ${runtimeEvents.metadata}->'contentBefore' <> 'null'::jsonb
      OR ${runtimeEvents.metadata}->'httpRequest' IS NOT NULL AND ${runtimeEvents.metadata}->'httpRequest' <> 'null'::jsonb
      OR ${runtimeEvents.metadata}->'contentAfter' IS NOT NULL AND ${runtimeEvents.metadata}->'contentAfter' <> 'null'::jsonb)`;
    const [item] = await boundedRead(this.db, tx => tx.select({ ...getTableColumns(runtimeEvents), metadata }).from(runtimeEvents).where(and(eq(runtimeEvents.id, id), resourceWritePredicate(runtimeEvents.projectId))).limit(1));
    if (!item) throw new NotFoundError("Runtime event", id);
    const { contentCiphertext: _ciphertext, contentBefore: _before, contentAfter: _after, httpRequest: _httpRequest, modelExchanges: _modelExchanges, ...safe } = item.metadata;
    const { allocationContextId: _allocationContextId, ...visible } = item;
    return { ...visible, metadata: includeContent ? decryptRuntimeEventMetadata(item.metadata, this.runtimeLogEncryptionKey) : safe };
  }

  private endpointActivityCache = new Map<string, { until: number; value: { items: Record<string, unknown>[] } }>();
  private endpointActivityJobs = new Map<string, Promise<{ items: Record<string, unknown>[] }>>();
  async runtimeEndpointActivity() {
    // Shared Endpoints can disappear as soon as a grant is revoked. Keep the
    // system cache, but re-evaluate project reads against the live grant table.
    const cacheable = currentProjectId() === null;
    const key = "system";
    if (cacheable) {
      const cached = this.endpointActivityCache.get(key);
      if (cached && cached.until > Date.now()) return cached.value;
      const pending = this.endpointActivityJobs.get(key);
      if (pending) return pending;
    }
    const job = boundedRead(this.db, async tx => {
      // Lifetime timestamps are index probes; only recent counters scan a time window.
      const scope = and(
        eq(runtimeEvents.endpointId, endpoints.id),
        currentProjectId() ? eq(runtimeEvents.projectId, currentProjectId()!) : undefined,
      );
      const errors = runtimeExecutionError(runtimeEvents.metadata);
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
        .where(and(isNull(endpoints.deletedAt), resourceReadPredicate("endpoint", endpoints.id, endpoints.projectId)));
      return { items };
    });
    if (cacheable) this.endpointActivityJobs.set(key, job);
    try {
      const value = await job;
      if (cacheable) this.endpointActivityCache.set(key, { until: Date.now() + 10_000, value });
      return value;
    } finally { if (cacheable) this.endpointActivityJobs.delete(key); }
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
    const executionError = runtimeExecutionError(runtimeEvents.metadata);
    const severities = input.severity ? (Array.isArray(input.severity) ? input.severity : [input.severity]) : [];
    const conditions = [
      currentProjectId() ? eq(runtimeEvents.projectId, currentProjectId()!) : undefined,
      severities.length ? exists(this.db.select({ severity: findingSeverity(findings.item) }).from(findings.source).where(and(securityFinding(findings.item), inArray(findingSeverity(findings.item), severities)))) : undefined,
      cursor ? lt(rowValue(runtimeEvents.occurredAt, runtimeEvents.id), rowValue(timestampValue(cursor.at), literal(cursor.id))) : undefined,
      input.requestId ? eq(runtimeEvents.requestId, input.requestId) : undefined,
      input.direction ? eq(runtimeEvents.direction, input.direction) : undefined,
      input.outcome === 'error' ? executionError : input.outcome ? eq(runtimeEvents.decision, input.outcome) : undefined,
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
      ...Object.fromEntries(['modelEvidenceStatus','modelEvidenceCount','modelStatus','protectionMode','detectionDecision','detectionError','executionStatus','terminationReason','captureLevel','runtimeLogCaptured','protocol','action','timedOut','timed_out','streamFinalCheck','routeId','targetId','routerRevision','decisionId','logKind','completionInferred','failureReason','completedAt'].map(key => [key,jsonValue(runtimeEvents.metadata, key)])),
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

  async createEndpoint(input: { name: string; adapter: string; credentialRequired?: boolean | undefined; scanFlagOnlyDefault?: boolean | undefined; actorId: string }) {
    if (!["litellm-generic-guardrail", "f5-scan"].includes(input.adapter)) throw new ValidationError("Unsupported Endpoint adapter.");
    if (input.scanFlagOnlyDefault !== undefined && input.adapter !== "f5-scan") throw new ValidationError("scanFlagOnlyDefault is only supported by F5 Scan Endpoints.");
    const id = randomUUID();
    const issued = issueEndpointCredential();
    const verification = { credentials: [issued.stored] };
    const [created] = await this.db.transaction(async (tx) => {
      const rows = await tx.insert(endpoints).values({
        id, projectId: projectOwnerForCreate(), name: input.name, adapter: input.adapter, verification, credentialRequired: input.credentialRequired ?? true, scanFlagOnlyDefault: input.scanFlagOnlyDefault ?? true,
      }).returning();
      await this.advanceEndpointDesiredState(tx, {
        endpointId: id,
        actorId: input.actorId,
        auditKind: "endpoint.created",
        auditDetail: { name: input.name, adapter: input.adapter, credentialId: issued.stored.id, credentialRequired: input.credentialRequired ?? true,
          ...(input.adapter === "f5-scan" ? { scanFlagOnlyDefault: input.scanFlagOnlyDefault ?? true } : {}) },
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

  async updateEndpoint(input: { id: string; enabled?: boolean | undefined; credentialRequired?: boolean | undefined; scanFlagOnlyDefault?: boolean | undefined; actorId: string }) {
    await assertResourceWriteAccess(this.db, "endpoint", input.id);
    return this.db.transaction(async (tx) => {
      const [endpoint] = await tx.select().from(endpoints)
        .where(and(eq(endpoints.id, input.id), isNull(endpoints.deletedAt))).for("update");
      if (!endpoint) throw new NotFoundError("Endpoint", input.id);
      if (input.scanFlagOnlyDefault !== undefined && endpoint.adapter !== "f5-scan") throw new ValidationError("scanFlagOnlyDefault is only supported by F5 Scan Endpoints.");
      const status = input.enabled === undefined ? endpoint.status : input.enabled ? "active" : "disabled";
      const scanFlagOnlyDefault = input.scanFlagOnlyDefault ?? endpoint.scanFlagOnlyDefault;
      const scanChanged = scanFlagOnlyDefault !== endpoint.scanFlagOnlyDefault;
      const credentialRequired = input.credentialRequired ?? endpoint.credentialRequired;
      const credentialChanged = credentialRequired !== endpoint.credentialRequired;
      if (endpoint.status === status && !scanChanged && !credentialChanged) return this.publicEndpoint(endpoint);

      const now = new Date();
      const [updated] = await tx.update(endpoints).set({ status, scanFlagOnlyDefault, credentialRequired, updatedAt: now })
        .where(and(eq(endpoints.id, input.id), isNull(endpoints.deletedAt))).returning();
      if (!updated) throw new NotFoundError("Endpoint", input.id);
      await this.advanceEndpointDesiredState(tx, {
        endpointId: input.id,
        actorId: input.actorId,
        auditKind: scanChanged || credentialChanged ? "endpoint.updated" : input.enabled ? "endpoint.enabled" : "endpoint.disabled",
        auditDetail: { previousStatus: endpoint.status, status,
          ...(credentialChanged ? { previousCredentialRequired: endpoint.credentialRequired, credentialRequired } : {}),
          ...(scanChanged ? { previousScanFlagOnlyDefault: endpoint.scanFlagOnlyDefault, scanFlagOnlyDefault } : {}) },
      });
      return this.publicEndpoint(updated);
    });
  }

  async rotateEndpointCredential(input: { id: string; actorId: string }) {
    await assertResourceWriteAccess(this.db, "endpoint", input.id);
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
    await assertResourceWriteAccess(this.db, "endpoint", input.id);
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
    return (await this.guardrailDeletionImpacts(id)).visible;
  }

  private async guardrailDeletionImpacts(id: string): Promise<{ global: DeletionImpact; visible: DeletionImpact }> {
    await assertResourceWriteAccess(this.db, "guardrail", id);
    const [resource] = await this.db.select().from(guardrails).where(and(eq(guardrails.id, id), isNull(guardrails.deletedAt)));
    if (!resource) throw new NotFoundError("Guardrail", id);
    // Published Router revisions are distributed to every pool in their
    // owner's group, including Routers owned by a different project.
    const published = await this.db.select({ projectId: trafficRouters.projectId, activeSnapshot: trafficRouters.activeSnapshot }).from(trafficRouters)
      .where(and(isNull(trafficRouters.deletedAt), isNotNull(trafficRouters.activeRevision)));
    const referencing = published.filter((router) => router.activeSnapshot?.routes.some((route) => route.targets.some((target) => target.guardrailId === id)));
    const global = await this.deletionImpact("guardrail", id, referencing.length, referencing.map(router => router.projectId));
    const projectId = currentProjectId();
    return { global, visible: await this.visibleDeletionImpact("guardrail", id, global,
      projectId ? referencing.filter(router => router.projectId === projectId).length : referencing.length) };
  }

  async endpointDeletionImpact(id: string): Promise<DeletionImpact> {
    return (await this.endpointDeletionImpacts(id)).visible;
  }

  private async endpointDeletionImpacts(id: string): Promise<{ global: DeletionImpact; visible: DeletionImpact }> {
    await assertResourceWriteAccess(this.db, "endpoint", id);
    const [resource] = await this.db.select().from(endpoints).where(and(eq(endpoints.id, id), isNull(endpoints.deletedAt)));
    if (!resource) throw new NotFoundError("Endpoint", id);
    const [bound] = resource.trafficRouterId ? await this.db.select({ id: trafficRouters.id, projectId: trafficRouters.projectId }).from(trafficRouters)
      .where(and(eq(trafficRouters.id, resource.trafficRouterId), isNull(trafficRouters.deletedAt), isNotNull(trafficRouters.activeRevision))) : [];
    const global = await this.deletionImpact("endpoint", id, bound ? 1 : 0, bound ? [resource.projectId] : []);
    const projectId = currentProjectId();
    return { global, visible: await this.visibleDeletionImpact("endpoint", id, global,
      bound && (!projectId || bound.projectId === projectId) ? 1 : 0) };
  }

  async softDeleteGuardrail(input: { id: string; actorId: string; reason: string; confirmRecentTraffic: boolean; confirmationName?: string | undefined }) {
    await assertResourceWriteAccess(this.db, "guardrail", input.id);
    const [resource] = await this.db.select({ name: guardrails.name, projectId: guardrails.projectId }).from(guardrails)
      .where(and(eq(guardrails.id, input.id), isNull(guardrails.deletedAt)));
    if (!resource) throw new NotFoundError("Guardrail", input.id);
    const impacts = await this.guardrailDeletionImpacts(input.id);
    this.assertDeletionAllowed(impacts.global, input.confirmRecentTraffic, input.confirmationName, resource.name, impacts.visible);
    await this.db.transaction(async (tx) => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const [locked] = await tx.select({ id: guardrails.id }).from(guardrails)
        .where(and(eq(guardrails.id, input.id), isNull(guardrails.deletedAt), resourceWritePredicate(guardrails.projectId))).for("update");
      if (!locked) throw new NotFoundError("Guardrail", input.id);
      await this.trafficRouting.assertGuardrailUnused(input.id, tx);
      const [state] = await tx.update(controllerState)
        .set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton")).returning();
      if (!state) throw new Error("Controller state is not initialized.");
      const disabled = await tx.update(guardrails).set({
        status: "disabled", ...resetProtectionMode, protectionModeGeneration: state.desiredGeneration, deletedAt: new Date(), deletedBy: input.actorId,
        deleteReason: input.reason, desiredGeneration: state.desiredGeneration, updatedAt: new Date(),
      }).where(and(eq(guardrails.id, input.id), isNull(guardrails.deletedAt))).returning({ id: guardrails.id });
      if (!disabled[0]) throw new NotFoundError("Guardrail", input.id);
      const cleared = await clearGuardrailOperationalData(tx, input.id);
      await this.recordSoftDelete(tx, "guardrail", input, impacts.visible, state.desiredGeneration, resource.projectId, cleared);
    });
  }

  async softDeleteEndpoint(input: { id: string; actorId: string; reason: string; confirmRecentTraffic: boolean; confirmationName?: string | undefined }) {
    await assertResourceWriteAccess(this.db, "endpoint", input.id);
    const [resource] = await this.db.select({ name: endpoints.name, projectId: endpoints.projectId }).from(endpoints)
      .where(and(eq(endpoints.id, input.id), isNull(endpoints.deletedAt)));
    if (!resource) throw new NotFoundError("Endpoint", input.id);
    const impacts = await this.endpointDeletionImpacts(input.id);
    this.assertDeletionAllowed(impacts.global, input.confirmRecentTraffic, input.confirmationName, resource.name, impacts.visible);
    await this.db.transaction(async (tx) => {
      const [foreignRouter] = await tx.select({ id: trafficRouters.id }).from(trafficRouters)
        .innerJoin(endpoints, eq(endpoints.trafficRouterId, trafficRouters.id)).where(and(
          eq(endpoints.id, input.id), ne(trafficRouters.projectId, resource.projectId), isNull(trafficRouters.deletedAt),
        )).limit(1);
      if (foreignRouter) throw new ConflictError("Endpoint is still referenced by another project's Router.", "endpoint_in_use");
      const [state] = await tx.update(controllerState)
        .set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton")).returning();
      if (!state) throw new Error("Controller state is not initialized.");
      const disabled = await tx.update(endpoints).set({
        status: "disabled", deletedAt: new Date(), deletedBy: input.actorId,
        deleteReason: input.reason, updatedAt: new Date(),
      }).where(and(eq(endpoints.id, input.id), isNull(endpoints.deletedAt))).returning({ id: endpoints.id });
      if (!disabled[0]) throw new NotFoundError("Endpoint", input.id);
      await this.recordSoftDelete(tx, "endpoint", input, impacts.visible, state.desiredGeneration, resource.projectId);
    });
  }

  /** Called by the authenticated Playground handler before dispatching to a Runner.
   * Retained for delayed telemetry replay; expiry is checked against event time. */
  async registerPlaygroundInvocation(input: { callId: string; projectId: string; guardrailId: string; guardrailVersion: string; poolId: string; groupId: string }): Promise<void> {
    const now = new Date();
    await this.db.insert(playgroundInvocations).values({ ...input, createdAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) });
    // Keep mappings for at least 30 days after their one-day validity so delayed
    // Runner WAL replay can still be attributed. Older replays are quarantined.
    if (now.getTime() - this.lastPlaygroundInvocationCleanup > 60 * 60 * 1000) {
      this.lastPlaygroundInvocationCleanup = now.getTime();
      try {
        await this.db.delete(playgroundInvocations).where(lt(playgroundInvocations.expiresAt, new Date(now.getTime() - 30 * 86400000)));
      } catch (error) {
        this.lastPlaygroundInvocationCleanup = 0;
        console.warn("Failed to clean up expired Playground invocation contexts", error);
      }
    }
  }

  async recordRuntimeEvents(events: readonly RuntimeEventInput[], authenticatedPoolId?: string, transaction?: Transaction): Promise<void> {
    if (events.length === 0) return;
    const prepare = async (tx: Transaction, batch: readonly RuntimeEventInput[]) => {
      const accepts = await guardrailTelemetryFilter(tx, batch.map(event => event.guardrailId));
      if (batch.some(event => event.allocationContextId)) await lockEndpointTelemetryContextReaders(tx);
      const recordCosts = modelUsageCostRecorder(tx, authenticatedPoolId);
      const watermarks = telemetryWatermarkBatch(tx);
      return { write: async (event: RuntimeEventInput) => {
        if (!accepts(event.guardrailId, event.occurredAt)) return;
        if (event.metadata.costOnly !== true) await writeRuntimeEvent(tx, event, authenticatedPoolId);
        await recordCosts(event);
        // A pool token does not authenticate a particular Runner/boot.
        if (authenticatedPoolId === undefined) watermarks.add(event.runnerId, event.occurredAt);
      }, finish: () => watermarks.flush() };
    };
    if (transaction) {
      const writer = await prepare(transaction, events);
      for (const event of events) await writer.write(event);
      await writer.finish();
    } else await telemetryBatches(this.db, events, prepare);
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

  async registerRunner(input: RunnerRegistration, controlSessionId?: string): Promise<number> {
    if (controlSessionId !== undefined && (!controlSessionId || controlSessionId !== controlSessionId.trim() || controlSessionId.length > 256)) {
      throw new ValidationError("Runner control session identity is invalid.");
    }
    return this.db.transaction(async tx => {
    // Serialize registration with group moves: an unallocated pool must never
    // temporarily receive the default group's project configuration.
    await advisoryTransactionLock(tx, "traffic-router-bindings");
    const [pool] = await tx.select({ id: runnerPools.id, projectId: runnerPools.projectId, projectName: projects.name }).from(runnerPools)
      .leftJoin(projects,eq(projects.id,runnerPools.projectId)).where(eq(runnerPools.id, input.poolId)).limit(1);
    if (!pool) throw new ValidationError("Runner pool is not registered. An administrator must allocate it to a project group first.");
    if (this.config.runnerPoolTokens != null) {
      // A pool-scoped principal must not take over a globally identified Runner
      // registered to a different pool, even if the old registration is offline.
      const [previous] = await tx.select({ poolId: runnerInstances.poolId }).from(runnerInstances)
        .where(eq(runnerInstances.runnerId, input.runnerId)).limit(1);
      if (previous && previous.poolId !== input.poolId) {
        throw new ConflictError("Runner ID is already registered to another pool.", "runner_pool_identity_conflict");
      }
    }
    const projectName = pool.id === "default" ? "default" : pool.projectName;
    if (!projectName || !isRunnerName(input.runnerId, projectName)) throw new ValidationError(
      projectName ? `Runner ID must be runner-${projectName}-<ordinal>, starting at 0.` : "Runner pool has no Project binding.");
    const [state] = await tx.select({ generation: controllerState.desiredGeneration }).from(controllerState).where(eq(controllerState.id, "singleton")).limit(1);
    if (!state) throw new Error("Controller state is not initialized.");
    const desiredGeneration = state.generation;
    // Superseding the same boot on another Controller must invalidate that
    // stream without erasing its grants or historical snapshot evidence.
    const [prior] = await tx.select({ sessionId: runnerInstances.controlSessionId }).from(runnerInstances)
      .where(eq(runnerInstances.runnerId, input.runnerId));
    if (prior?.sessionId) await tx.update(runnerControlSessions).set({ disconnectedAt: new Date() })
      .where(eq(runnerControlSessions.id, prior.sessionId));
    if (controlSessionId) await tx.insert(runnerControlSessions).values({ id: controlSessionId,
      runnerId: input.runnerId, bootId: input.bootId, poolId: input.poolId });
    await tx.insert(runnerInstances).values({
      ...input,
      controlSessionId: controlSessionId ?? null,
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
        controlSessionId: controlSessionId ?? null,
        poolId: input.poolId,
        runnerVersion: input.runnerVersion,
        nemoVersion: input.nemoVersion,
        maxConcurrency: input.maxConcurrency,
        compilerCapable: input.compilerCapable,
        labels: input.labels,
        desiredGeneration,
        appliedGeneration: input.appliedGeneration,
        protectionGeneration: 0,
        protectionRejectedGeneration: 0,
        protectionError: null,
        heartbeatSequence: 0,
        status: input.appliedGeneration === desiredGeneration ? "ready" : "syncing",
        connectedAt: new Date(),
        lastHeartbeatAt: new Date(),
        disconnectedAt: null,
        updatedAt: new Date(),
      },
    });
    return desiredGeneration;
    });
  }

  async recordHeartbeat(input: {
    runnerId: string; bootId: string; sequence: number; appliedGeneration: number; load: RunnerLoad; controlSessionId?: string; admissionSnapshot?: Uint8Array;
  }): Promise<boolean> {
    const accepted = await this.db.transaction(async tx => {
    await advisoryTransactionLock(tx, "traffic-router-bindings");
    const [state] = await tx.select({ generation: controllerState.desiredGeneration }).from(controllerState)
      .where(eq(controllerState.id, "singleton"));
    if (!state) throw new Error("Controller state is not initialized.");
    const desiredGeneration = state.generation;
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
    const updated = await tx.update(runnerInstances).set({
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
      sql`${runnerInstances.controlSessionId} IS NOT DISTINCT FROM ${input.controlSessionId ?? null}`,
      isNull(runnerInstances.disconnectedAt),
      lt(runnerInstances.heartbeatSequence, input.sequence),
    )).returning({ runnerId: runnerInstances.runnerId, poolId: runnerInstances.poolId });
    return updated[0] ?? null;
    });
    if (accepted) this.admissionMonitor.record({ runnerId: input.runnerId, bootId: input.bootId,
      controlSessionId: input.controlSessionId ?? null, poolId: accepted.poolId, sequence: input.sequence }, input.admissionSnapshot);
    return accepted !== null;
  }

  async disconnectRunner(runnerId: string, bootId: string, controlSessionId?: string): Promise<void> {
    await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const updated = await tx.update(runnerInstances).set({ status: "offline", disconnectedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(runnerInstances.runnerId, runnerId), eq(runnerInstances.bootId, bootId),
          sql`${runnerInstances.controlSessionId} IS NOT DISTINCT FROM ${controlSessionId ?? null}`))
        .returning({ sessionId: runnerInstances.controlSessionId });
      if (updated[0]?.sessionId) await tx.update(runnerControlSessions).set({ disconnectedAt: new Date() })
        .where(eq(runnerControlSessions.id, updated[0].sessionId));
    });
  }

  async markStaleRunnersOffline(): Promise<void> {
    const cutoff = new Date(Date.now() - this.config.offlineAfterSeconds * 1_000);
    await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const stale = await tx.update(runnerInstances).set({ status: "offline", disconnectedAt: new Date(), updatedAt: new Date() })
        .where(and(lte(runnerInstances.lastHeartbeatAt, cutoff), ne(runnerInstances.status, 'offline')))
        .returning({ sessionId: runnerInstances.controlSessionId });
      const sessionIds = stale.flatMap(row => row.sessionId ? [row.sessionId] : []);
      if (sessionIds.length) await tx.update(runnerControlSessions).set({ disconnectedAt: new Date() })
        .where(inArray(runnerControlSessions.id, sessionIds));
    });
  }

  async desiredStateForPool(poolId: string, runtimeModels?: (tx: Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0]) => Promise<import("../model-config/domain.js").ActiveModelConfiguration | null>) {
    return this.db.transaction(async tx => {
    await advisoryTransactionLock(tx, "traffic-router-bindings");
    const [allocation] = await tx.select({ groupId: runnerPools.groupId }).from(runnerPools)
      .innerJoin(projectGroups, eq(projectGroups.id, runnerPools.groupId))
      .where(eq(runnerPools.id, poolId)).limit(1);
    if (!allocation?.groupId) throw new ConflictError("Runner Pool has no valid project group allocation.", "runner_pool_group_unavailable");
    // Hold generation through projection/persistence. Generation writers can
    // commit before this lock or after it, never between the snapshot reads.
    const [state] = await tx.select().from(controllerState).where(eq(controllerState.id, "singleton")).for("share");
    const generation = state?.desiredGeneration ?? 0;
    const groupProjects = await tx.select({ id: projects.id }).from(projects)
      .innerJoin(runnerPools, projectPoolAllocation).where(eq(runnerPools.id, poolId));
    const projectIds = groupProjects.map(project => project.id);
    const routerRevisions = await this.trafficRouting.runtimeSnapshots(projectIds, tx);
    // Routed Artifacts are always included. Other visible versions need a
    // compatible Runner load check before being preloaded for Playground.
    const referencedArtifactIds = new Set(routerRevisions.flatMap((router) => router.routes.flatMap((route) => route.targets.map((target) => target.artifactId).filter(Boolean))));
    const visibleGuardrail = projectIds.length ? inArray(guardrails.projectId, projectIds) : sql`false`;
    const readyArtifacts = await tx.select({ artifact: artifacts }).from(guardrailVersions)
      .innerJoin(guardrails, and(eq(guardrails.id, guardrailVersions.guardrailId), isNull(guardrails.deletedAt)))
      .innerJoin(artifacts, eq(artifacts.id, guardrailVersions.artifactId))
      .where(or(
        inArray(artifacts.id, [...referencedArtifactIds]),
        and(visibleGuardrail, eq(guardrailVersions.status, "ready"), sql`${guardrailVersions.environmentCheck}->>'status' = 'compatible'`),
      ));
    const activeArtifacts = readyArtifacts.filter(row => referencedArtifactIds.has(row.artifact.id) || !artifactExecutionContractIssue(row.artifact));
    const disabledGuardrails = await tx.select({ id: guardrails.id }).from(guardrails).where(and(visibleGuardrail, eq(guardrails.status, "disabled")));
    const loggingLevels = await tx.select({ id: guardrails.id, level: guardrails.loggingLevel })
      .from(guardrails).where(and(visibleGuardrail, isNull(guardrails.deletedAt)));
    const ownedEndpoint = projectIds.length ? inArray(endpoints.projectId, projectIds) : sql`false`;
    const disabledEndpoints = await tx.select({ id: endpoints.id }).from(endpoints).where(and(ownedEndpoint, eq(endpoints.status, "disabled"), isNull(endpoints.deletedAt)));
    const endpointRows = await tx.select().from(endpoints).where(and(ownedEndpoint, eq(endpoints.status, "active"), isNull(endpoints.deletedAt)));
    const endpointProjection = endpointRows.map(endpoint => ({ endpointId: endpoint.id, projectId: endpoint.projectId,
      trafficRouterId: routerRevisions.find(router => router.routerId === endpoint.trafficRouterId && router.endpointIds.includes(endpoint.id))?.routerId ?? null,
      adapter: endpoint.adapter, verification: endpoint.verification, scanFlagOnlyDefault: endpoint.scanFlagOnlyDefault, credentialRequired: endpoint.credentialRequired }));
    const [epoch] = await tx.select({ epoch: runnerPoolLeaseEpochs.epoch }).from(runnerPoolLeaseEpochs).where(eq(runnerPoolLeaseEpochs.poolId, poolId));
    const telemetryContexts = this.config.runnerScopedTelemetry ? await issueEndpointTelemetryContexts(tx, {
      poolId, groupId: allocation.groupId, epoch: epoch?.epoch ?? 0, generation, endpoints: endpointProjection, routers: routerRevisions,
    }, this.config.endpointContextStorage) : new Map<string, string>();
    const runtimeModelConfiguration = runtimeModels ? await runtimeModels(tx) : undefined;
    return {
      ...(runtimeModels ? { runtimeModelConfiguration } : {}),
      generation,
      groupId: allocation.groupId,
      allocationEpoch: epoch?.epoch ?? 0,
      artifacts: [...new Map(activeArtifacts.map((row) => [row.artifact.id, row.artifact])).values()],
      disabledGuardrailIds: disabledGuardrails.map((row) => row.id),
      disabledEndpointIds: disabledEndpoints.map((row) => row.id),
      routerRevisions: routerRevisions.map(router => ({ ...router, assignmentAlgorithm: "hmac-sha256-v1", assignmentKeyId: "v1", assignmentKey: createHash("sha256").update("traffic-router-assignment-v1:" + this.config.runnerToken).digest() })),
      endpoints: endpointProjection.map(endpoint => ({ ...endpoint, telemetryContextId: telemetryContexts.get(endpoint.endpointId) })),
      guardrailLoggingLevels: Object.fromEntries(loggingLevels.map((item) => [item.id, item.level])),
    };
    });
  }

  async requiredPlatformModelBindings() {
    const required = new Set<import("../../shared/guardrail-catalog.js").CapabilityBindingId>();
    // Only enabled published routes require models. Drafts, archived versions
    // and unused assignments must not make a local installation unhealthy.
    const routers = await this.db.select({ snapshot: trafficRouters.activeSnapshot }).from(trafficRouters)
      .where(and(isNull(trafficRouters.deletedAt), isNotNull(trafficRouters.activeSnapshot)));
    const targets = routers.flatMap(router => router.snapshot!.routes.filter(route => route.enabled)
      .flatMap(route => route.targets.filter(target => target.weightBps > 0)));
    if (targets.length) {
      const plans = await this.db.select({ plan: artifacts.plan }).from(artifacts)
        .innerJoin(guardrails, eq(guardrails.id, artifacts.guardrailId))
        .where(and(isNull(guardrails.deletedAt), ne(guardrails.status, "disabled"), or(...targets.map(target => and(
          eq(artifacts.guardrailId, target.guardrailId), eq(artifacts.guardrailVersion, target.guardrailVersion),
        )))));
      for (const { plan } of plans) for (const binding of publishedProtectionCoverage(plan)?.requiredModelBindings ?? []) required.add(binding);
    }
    return [...required];
  }

  async listRunnerHeartbeats() {
    const projectId = currentProjectId();
    return this.db.select({ status: runnerInstances.status, lastHeartbeatAt: runnerInstances.lastHeartbeatAt })
      .from(runnerInstances).innerJoin(runnerPools, eq(runnerPools.id, runnerInstances.poolId))
      .where(projectId ? sql`exists (select 1 from ${projects}
        where ${projects.id} = ${projectId} and ${projectPoolAllocation})` : undefined);
  }

  async listRunnerPoolsWithCapacity() {
    const projectId = currentProjectId();
    const pools = await this.db.select().from(runnerPools).where(projectId ? sql`exists (select 1 from ${projects}
      where ${projects.id} = ${projectId} and ${projectPoolAllocation})` : undefined)
      .orderBy(desc(runnerPools.isDefault), runnerPools.name);
    const instances = pools.length ? await this.db.select().from(runnerInstances).where(inArray(runnerInstances.poolId, pools.map(pool => pool.id))) : [];
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
        // Stream ownership is an internal authorization detail, not fleet UI data.
        instances: instances.filter((runner) => runner.poolId === pool.id).map(({ controlSessionId: _session, ...runner }) => runner),
        capacity: calculatePoolCapacity(
          poolRunners,
          pool.safeRpsPerRunner,
          undefined,
          1.25,
          1,
        ),
      };
    });
  }

  async observabilitySnapshot() {
    const [watermarks, pendingOutbox, guardrailRows, routerRows, endpointRows, allocations] = await Promise.all([
      this.config.runnerScopedTelemetry ? Promise.resolve([]) : this.db.select().from(telemetryWatermarks),
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
        projectId: trafficRouters.projectId,
        activeRevision: trafficRouters.activeRevision,
        activeSnapshot: trafficRouters.activeSnapshot,
      }).from(trafficRouters).where(isNull(trafficRouters.deletedAt)),
      this.db.select({
        id: endpoints.id,
        name: endpoints.name,
        projectId: endpoints.projectId,
        adapter: endpoints.adapter,
        status: endpoints.status,
        deletedAt: endpoints.deletedAt,
        trafficRouterId: endpoints.trafficRouterId,
      }).from(endpoints),
      this.db.select({ projectId: projects.id, poolId: runnerPools.id }).from(projects)
        .innerJoin(runnerPools, projectPoolAllocation),
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
    // Desired-state distribution includes every pool allocated to the Router's project.
    const projectPools = new Map<string, string[]>();
    for (const allocation of allocations) {
      const ids = projectPools.get(allocation.projectId) ?? [];
      ids.push(allocation.poolId);
      projectPools.set(allocation.projectId, ids);
    }
    const priority = { disabled: 0, inactive: 1, active: 2 } as const;
    const routerTopology = routerRows.flatMap((router) => {
      if (!router.activeSnapshot) return [];
      const boundEndpoints = endpointRows.filter((endpoint) => endpoint.trafficRouterId === router.id && endpoint.projectId === router.projectId && endpoint.deletedAt === null);
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
      return (projectPools.get(router.projectId) ?? []).flatMap(poolId => [...targets.values()].map(({ guardrailId, guardrailVersion }) => {
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
      }));
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
    assertPlatformAuthority();
    if (!Number.isInteger(input.desiredReplicas) || input.desiredReplicas < 1) {
      throw new ValidationError("Runner pools require at least one desired replica.", {
        minimumDesiredReplicas: 1,
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
    assertPlatformAuthority();
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

  async pendingOutbox(kind: string, limit = 50, excludedRunIds: string[] = []) {
    return this.db.select().from(outboxEvents).where(and(
      eq(outboxEvents.kind, kind), isNull(outboxEvents.processedAt), lte(outboxEvents.availableAt, new Date()),
      excludedRunIds.length ? notInArray(sql`${outboxEvents.payload}->>'runId'`, excludedRunIds) : undefined,
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
    const [record] = await this.db.select().from(policyRecords).where(and(
      eq(policyRecords.id, id), resourceReadPredicate("policy", policyRecords.id, policyRecords.projectId),
    ));
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
    // Drafts may be incomplete; compilation checks executable structure separately.
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

  private async ensureDefaultGuardrail(tx: Transaction, projectId?: string): Promise<void> {
    const key = projectId ? `project-default:${projectId}` : "initial-guardrail";
    const [installed] = await tx.select().from(deploymentPresets).where(eq(deploymentPresets.key, key));
    if (installed) return;
    const catalog = this.policyCatalog().list();
    const draft = profileDraft(localBaseline, catalog);
    const guardrail = await this.createGuardrailIn(tx, { platformPreset: !projectId, name: "Default", draftConfig: draft, runtimeProfile: "auto", actorId: null });
    // The deployment carries precompiled content. Rebind its ordinary identity,
    // verify the same frozen plan and use the common publication transaction.
    const content = canonicalArtifactContent({ ...bundledDefault, guardrailId: guardrail.id,
      plan: { ...bundledDefault.plan, guardrail_id: guardrail.id } }, this.config.protoPath);
    const plan = buildGuardrailPlan({ guardrailId: guardrail.id, guardrailVersion: content.guardrailVersion, draft, policies: catalog });
    if (canonicalJson(planToWire(content.plan)) !== canonicalJson(planToWire(plan)))
      throw new Error("Deployment Profile does not match its bundled Artifact. Regenerate before release.");
    const cases = await tx.select().from(testCases).where(eq(testCases.guardrailId, guardrail.id));
    const suite = freezeTestSuite(applyValidationOverrides(cases, draft));
    await this.publishCandidate(tx, guardrail, { id: null, guardrailVersion: content.guardrailVersion,
      sourceDraftRevision: guardrail.draftRevision, candidateArtifact: content, candidateDigest: artifactContentDigest(content),
      candidateInspection: guardrailInspection({ name: guardrail.name, runtimeProfile: guardrail.runtimeProfile, draftConfig: draft, catalog, programmablePolicies: [], testSuite: suite }),
      candidatePolicies: guardrailPolicyNodes(draft.policyBindings, catalog, []), testSuite: suite }, null);
    await tx.insert(deploymentPresets).values({ key, guardrailId: guardrail.id, profileId: localBaseline.id, profileVersion: localBaseline.version });
  }

  private async validateGuardrailDraft(draft: GuardrailDraftConfig, db: Pick<ControllerDatabase, "select"> = this.db, previous?: GuardrailDraftConfig) {
    try {
      const catalog = await this.catalogPolicies(undefined, db);
      const programmablePolicies = await this.resolveProgrammablePolicies(draft, catalog, db);
      if (draft.policyBindings.some(binding => Object.keys(binding.testCaseOverrides ?? {}).length)) {
        let reference = previous;
        if (!reference && draft.profileOrigin) {
          const profile = (await readGuardrailProfiles(db)).find(item => item.id === draft.profileOrigin!.id && item.version === draft.profileOrigin!.version);
          if (profile) reference = profileDraft(profile, catalog);
        }
        if (reference) {
          const referencePolicies = await this.resolveProgrammablePolicies(reference, catalog, db);
          reconcileValidationOverrides(draft, reference, generatedTestCases("reference", reference, catalog, referencePolicies));
        }
      }
      buildGuardrailPlan({
        guardrailId: "guardrail-draft-validation",
        guardrailVersion: guardrailVersionId(),
        draft,
        policies: catalog,
        programmablePolicies,
      });
      applyValidationOverrides(generatedTestCases("candidate", draft, catalog, programmablePolicies), draft);
      return { catalog, programmablePolicies };
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : "Guardrail draft is invalid.");
    }
  }

  private async resolveProgrammablePolicies(draft: GuardrailDraftConfig, catalog: PolicyDto[], db: Pick<ControllerDatabase, "select"> = this.db): Promise<ProgrammablePolicySnapshot[]> {
    const customBindings = draft.policyBindings.filter((binding) => !catalog.some(policy => policy.id === binding.policyId));
    if (!customBindings.length) return [];
    const ids = [...new Set(customBindings.map((item) => item.policyId))];
    const rows = await db.select({ policyId: policyVersions.policyId, version: policyVersions.version, snapshot: policyVersions.snapshot })
      .from(policyVersions).innerJoin(policyRecords, eq(policyRecords.id, policyVersions.policyId))
      .where(and(inArray(policyVersions.policyId, ids), resourceReadPredicate("policy", policyRecords.id, policyRecords.projectId)));
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
    // Resource readiness is derived from published executable versions,
    // never from the mutable draft, traffic references or the cached lifecycle flag.
    const versionRows = await this.db.select({ version: guardrailVersions.version, status: guardrailVersions.status,
      checksum: artifacts.checksum }).from(guardrailVersions)
      .leftJoin(artifacts, and(eq(artifacts.id, guardrailVersions.artifactId), eq(artifacts.guardrailId, row.id), eq(artifacts.guardrailVersion, guardrailVersions.version))).where(eq(guardrailVersions.guardrailId, row.id));
    const released = versionRows.filter(version => version.status === "ready" && version.checksum).length;
    const pending = versionRows.filter(version => version.status === "pending").length;
    const versionSummary = { total: versionRows.length, released, pending, missingEvidence: versionRows.length - pending - released };
    // The draft's own testing state; runs against existing versions are not about
    // the draft, regardless of where the Guardrail was created.
    const [latestValidation] = await this.db.select(validationSummaryColumns).from(validationRuns)
      .where(and(eq(validationRuns.guardrailId, row.id), eq(validationRuns.subject, "draft")))
      .orderBy(desc(validationRuns.createdAt)).limit(1);
    const [latestTestingReport] = await this.db.select(validationSummaryColumns).from(validationRuns)
      .where(eq(validationRuns.guardrailId, row.id)).orderBy(desc(validationRuns.createdAt), desc(validationRuns.id)).limit(1);
    const [caseCount] = await this.db.select({ value: count() }).from(testCases)
      .where(eq(testCases.guardrailId, row.id));
    const published = await this.lastPublishedVersion(this.db, row.id);
    let hasUnpublishedChanges = !published || published.sourceDraftRevision !== row.draftRevision;
    if (hasUnpublishedChanges && published?.sourceSnapshot?.testCases) {
      const cases = await this.db.select().from(testCases).where(eq(testCases.guardrailId, row.id));
      hasUnpublishedChanges = !sameDraftContent(published.sourceSnapshot, { draftConfig: row.draftConfig, runtimeProfile: row.runtimeProfile,
        loggingLevel: row.loggingLevel, excludedTestCaseIds: row.excludedTestCaseIds, testCases: cases });
    }
    const { duplicateKey: _duplicateKey, creationKey: _creationKey, creationDigest: _creationDigest, copyOrigin,
      protectionMode: _mode, protectionModeApplied: _appliedMode, protectionModeGeneration: _modeGeneration,
      protectionModeUpdatedAt: _modeUpdatedAt, protectionModeUpdatedBy: _modeUpdatedBy, protectionModeReason: _modeReason,
      ...publicRow } = row;
    const { requestDigest: _requestDigest, ...publicOrigin } = copyOrigin ?? {};
    const draftConfig = normalizeGuardrailDraft(row.draftConfig);
    return {
      ...publicRow,
      readiness: released > 0 && row.status !== "disabled" ? "ready" as const : "not_ready" as const,
      protection: await this.protectionModes.summary(row, released > 0 && row.status !== "disabled"),
      versionSummary,
      copyOrigin: copyOrigin ? publicOrigin : null,
      draftConfig,
      excludedTestCaseIds: row.excludedTestCaseIds,
      latestValidationRun: latestValidation ?? null,
      latestTestingReport: latestTestingReport ?? null,
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
    const catalog = await this.catalogPolicies(undefined, tx);
    const programmablePolicies = await this.resolveProgrammablePolicies(draft, catalog, tx);
    const generated = generatedTestCases(guardrailId, draft, catalog, programmablePolicies);
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
      projectId: endpoint.projectId,
      trafficRouterId: endpoint.trafficRouterId,
      name: endpoint.name,
      adapter: endpoint.adapter,
      status: endpoint.status,
      credentialRequired: endpoint.credentialRequired,
      ...(endpoint.adapter === "f5-scan" ? { scanFlagOnlyDefault: endpoint.scanFlagOnlyDefault } : {}),
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
      credentials: publicEndpointCredentials(endpoint.verification),
      setup: endpointSetup(this.config.runtimePublicUrl ?? new URL(this.config.publicUrl).origin, endpoint.id, endpoint.adapter, endpoint.credentialRequired),
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

  private async deletionImpact(kind: "guardrail" | "endpoint" | "router", id: string, activeRouterCount: number, routerProjectIds: readonly string[]): Promise<DeletionImpact> {
    const cutoff = new Date(Date.now() - this.config.deletionTrafficWindowMinutes * 60_000);
    const condition = kind === "guardrail"
      ? eq(runtimeEvents.guardrailId, id)
      : kind === "endpoint"
        ? eq(runtimeEvents.endpointId, id)
        : eq(runtimeEvents.routerId, id);
    const [traffic] = await this.db.select({ requestCount: count(), lastRequestAt: max(runtimeEvents.occurredAt) })
      .from(runtimeEvents).where(and(condition, eq(runtimeEvents.direction, "incoming"), gte(runtimeEvents.occurredAt, cutoff)));
    // A group may have multiple pools, and a shared Guardrail can be used by
    // Routers in several groups. No pool mapping is treated as stale, never
    // as permission to use the default pool's health.
    const allocations = await Promise.all([...new Set(routerProjectIds)].map(projectId => this.groupRouting.poolsForProject(projectId)));
    const missingPool = allocations.some(pools => pools.length === 0);
    const uniquePoolIds = [...new Set(allocations.flatMap(pools => pools.map(pool => pool.id)))];
    const runnerTelemetry = uniquePoolIds.length === 0 ? [] : await this.db.select({
      poolId: runnerInstances.poolId,
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
    // With scoped ingestion, Endpoint and routing evidence is quarantined and
    // no Runner/boot watermark is authenticated. Even a Router-free resource
    // can have direct Playground traffic. Legacy watermark rows, including
    // rows updated by old Controllers during rollout, are not evidence of
    // completeness in this mode.
    const telemetryFresh = !this.config.runnerScopedTelemetry && (activeRouterCount === 0 || (
      !missingPool && uniquePoolIds.length > 0
      && uniquePoolIds.every(poolId => servingRunners.some(runner => runner.poolId === poolId))
      && servingRunners.every((runner) => Boolean(runner.lastReceivedAt && runner.lastReceivedAt.getTime() >= telemetryCutoff))
    ));
    const telemetryWatermark = !telemetryFresh || servingRunners.some((runner) => !runner.lastReceivedAt)
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

  /** Safety checks remain global, but project-visible aggregates must not disclose
   * the activity or pool watermarks of other projects (including unknown events). */
  private async visibleDeletionImpact(kind: "guardrail" | "endpoint", id: string, global: DeletionImpact, activeRouterCount: number): Promise<DeletionImpact> {
    const projectId = currentProjectId();
    if (!projectId) return global;
    const cutoff = new Date(Date.now() - global.windowMinutes * 60_000);
    const resource = kind === "guardrail" ? eq(runtimeEvents.guardrailId, id) : eq(runtimeEvents.endpointId, id);
    const [traffic] = await this.db.select({ requestCount: count(), lastRequestAt: max(runtimeEvents.occurredAt) })
      .from(runtimeEvents).where(and(resource, eq(runtimeEvents.projectId, projectId),
        eq(runtimeEvents.direction, "incoming"), gte(runtimeEvents.occurredAt, cutoff)));
    return { ...global, incomingRequestCount: traffic?.requestCount ?? 0, lastRequestAt: traffic?.lastRequestAt ?? null,
      activeRouterCount, telemetryWatermark: null };
  }

  private assertDeletionAllowed(
    impact: DeletionImpact,
    confirmed: boolean,
    confirmationName: string | undefined,
    resourceName: string,
    visibleImpact: DeletionImpact = impact,
  ): void {
    if (!impact.telemetryFresh) {
      throw new ConflictError(
        "Runtime telemetry is stale, so recent traffic cannot be evaluated safely.",
        "telemetry_stale",
        { impact: visibleImpact },
      );
    }
    if (impact.requiresSecondConfirmation && !confirmed) {
      throw new ConflictError(
        "Recent incoming traffic requires explicit second confirmation.",
        "recent_traffic_confirmation_required",
        { impact: visibleImpact },
      );
    }
    if (impact.requiresSecondConfirmation && confirmationName !== resourceName) {
      throw new ConflictError(
        "The second confirmation must contain the exact resource name.",
        "confirmation_name_mismatch",
        { impact: visibleImpact },
      );
    }
  }

  private async recordSoftDelete(
    tx: Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0],
    resourceType: "guardrail" | "endpoint",
    input: { id: string; actorId: string; reason: string },
    impact: DeletionImpact,
    generation: number,
    projectId: string | null,
    cleared?: Awaited<ReturnType<typeof clearGuardrailOperationalData>>,
  ) {
    // Audit records are project-readable even when the deletion was performed
    // by a platform administrator. Do not persist global aggregate details.
    const auditImpact = { resourceId: impact.resourceId, windowMinutes: impact.windowMinutes,
      telemetryFresh: impact.telemetryFresh, requiresSecondConfirmation: impact.requiresSecondConfirmation };
    // An administrator's clear may include other projects' operational data.
    const auditCleared = cleared && !currentProjectId()
      ? { resetAt: cleared.resetAt, testingReports: cleared.testingReports, testRequests: cleared.testRequests }
      : cleared;
    await tx.insert(auditEvents).values({
      id: randomUUID(), projectId, kind: `${resourceType}.disabled`, actorId: input.actorId,
      resourceType, resourceId: input.id,
      detail: { reason: input.reason, impact: auditImpact, generation, ...(auditCleared ? { cleared: auditCleared } : {}) },
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
    deletable: true,
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
    project_id: record.projectId,
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
    // Imported with a Guardrail from source_id: read only here.
    origin: record.origin,
    source_id: record.sourceId,
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

/** A Policy imported with a Guardrail belongs to its source; change it there and release a new version. */


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
    compiler_version: "tasklattice-controller-plan-v1",
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

function policyValidationPayload(item: typeof policyValidationRuns.$inferSelect) {
  return {
    id: item.id,
    policy_id: item.policyId,
    draft_revision: item.draftRevision,
    status: item.status,
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
    modelExchanges: decrypted.modelExchanges ?? null,
    contentAvailable: true,
  };
}

/** Test reports carry the candidate's digest; its full content stays server-side. */
// The frozen suite is read through the version; results already echo each case.
function publicValidationRun<T extends object>(item: T) {
  const { candidateArtifact: _candidateArtifact, testSuite: _testSuite, ...run } = item as T & { candidateArtifact?: unknown; testSuite?: unknown };
  return run;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export function endpointSetup(runtimeBaseUrl: string, endpointId: string, adapter: string, credentialRequired = true) {
  const apiBaseUrl = `${runtimeBaseUrl.replace(/\/+$/, "")}/runtime/v1/endpoints/${encodeURIComponent(endpointId)}`;
  if (adapter === "f5-scan") {
    const callbackUrl = `${apiBaseUrl}/backend/v1/scans`;
    return {
      api_base_url: apiBaseUrl, callback_url: callbackUrl, stream_callback_url: null,
      auth_header: credentialRequired ? "Authorization: Bearer" : "", credential_env_var: credentialRequired ? "CALYPSOAI_TOKEN" : "", api_base_env_var: "CALYPSOAI_URL",
      recommended_modes: ["request", "response"], default_on: true, fail_on_error: true,
      unreachable_fallback: "fail_closed" as const,
      yaml_template: scanRequestCommand(callbackUrl, credentialRequired),
    };
  }
  if (adapter !== "litellm-generic-guardrail") throw new ValidationError("Unsupported Endpoint adapter.");
  const callbackUrl = `${apiBaseUrl}/beta/litellm_basic_guardrail_api`;
  const recommendedModes = ["pre_call", "post_call"];
  const yamlTemplate = [
        "# Requires the TaskLattice Guard endpoint supplied by Relay.",
        ...(credentialRequired ? ["credential_list:",
        "  - credential_name: tasklattice-guard",
        "    credential_info:",
        "      custom_llm_provider: tasklattice_guard",
        "    credential_values:",
        "      api_key: os.environ/TASKLATTICE_GUARD_API_KEY"] : []),
        "guardrails:",
        "  - guardrail_name: tasklattice-guard",
        "    litellm_params:",
        "      guardrail: tasklattice_guard",
        "      mode: [pre_call, post_call]",
        "      api_base: os.environ/TASKLATTICE_GUARD_API_BASE",
        ...(credentialRequired ? ["      credential_name: tasklattice-guard"] : []),
        "      default_on: true",
        "      fail_on_error: true",
        "      unreachable_fallback: fail_closed",
        "",
      ].join("\n");
  return {
    api_base_url: apiBaseUrl,
    callback_url: callbackUrl,
    stream_callback_url: null,
    auth_header: credentialRequired ? "x-api-key" : "",
    credential_env_var: credentialRequired ? "TASKLATTICE_GUARD_API_KEY" : "",
    api_base_env_var: "TASKLATTICE_GUARD_API_BASE",
    recommended_modes: recommendedModes,
    default_on: true,
    fail_on_error: true,
    unreachable_fallback: "fail_closed" as const,
    yaml_template: yamlTemplate,
  };
}
