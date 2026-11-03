import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson } from "../../shared/canonical-json.js";
import { groupModelConfigurationInput, type GroupModelConfigurationView } from "../../shared/group-model-configuration.js";
import type { ControllerDatabase } from "../db/client.js";
import { advisoryTransactionLock } from "../db/postgres-locks.js";
import { auditEvents, controllerState, groupModelConfigurations as policies, modelConfigurationRevisions,
  modelDefinitions, modelProviders, outboxEvents, runnerPoolLeaseEpochs, runnerPools, tenantGroups } from "../db/schema.js";
import { ConflictError, ControllerError, NotFoundError, ValidationError } from "../domain/errors.js";
import { assertPlatformAuthority, LEGACY_TENANT_ID } from "../services/tenant-context.js";
import { assignmentInputSchema, assignmentTargetAcceptsModel, capabilityBindings, emptyModelAssignments,
  modelProfiles, normalizeModelAssignments, type ActiveModelConfiguration } from "./domain.js";
import { decryptModelCredential } from "./secret-crypto.js";
import { modelBindingValidationFingerprint, modelRuntimeValidationFingerprint } from "./runtime-fingerprint.js";

export type GroupModelTransaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];
const prefix = "tenant-group-model:";
const snapshotSchema = z.object({ revisionId: z.string().min(1).max(256), revision: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative().nullable(), assignments: assignmentInputSchema,
  models: z.array(z.object({ id: z.string().uuid(), providerId: z.string().uuid(), providerName: z.string(),
    baseUrl: z.string().url(), credentialRef: z.string().uuid(), skipTlsVerify: z.boolean().default(false),
    model: z.string().min(1), profile: z.enum(modelProfiles), timeoutSeconds: z.number().positive(), maxTokens: z.number().int().positive(),
    maxConcurrency: z.number().int().min(1).max(64).default(2) })).max(64),
});
const ciphertextsSchema = z.record(z.string().uuid(), z.string().max(20_000));
type Policy = typeof policies.$inferSelect;
export type GroupRuntimeSelection = { groupId: string; mode: "legacy"; configuration: null } |
  { groupId: string; mode: "scoped" | "blocked"; configuration: ActiveModelConfiguration; credentials: Record<string, string> };

export function isGroupRuntimeConfigurationId(id: string): boolean { return id.startsWith(prefix); }
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const unavailable = () => new ControllerError("Group runtime Model configuration is unavailable.", 503, "group_model_configuration_unavailable");

/** Explicit group overrides. This grants future retrieval/configuration; it
 * cannot revoke a Provider key already delivered to an executing workload. */
export class GroupRuntimeModelService {
  constructor(private readonly db: ControllerDatabase, private readonly rootSecret: string) {}

  async assertAuthenticationCompatibility(poolAuthenticationEnabled: boolean): Promise<void> {
    if (poolAuthenticationEnabled) return;
    const [policy] = await this.db.select({ id: policies.id }).from(policies).where(ne(policies.mode, "legacy")).limit(1);
    if (policy) throw new Error("Pool authentication is required while scoped or blocked group Model policies exist.");
  }

  async view(groupId: string): Promise<GroupModelConfigurationView> {
    assertPlatformAuthority();
    const [group] = await this.db.select({ id: tenantGroups.id }).from(tenantGroups).where(eq(tenantGroups.id, groupId));
    if (!group) throw new NotFoundError("Tenant Group", groupId);
    const [policy] = await this.db.select().from(policies).where(eq(policies.groupId, groupId));
    return this.publicPolicy(groupId, policy);
  }

  async platformActivationPoolId(): Promise<string | null> {
    assertPlatformAuthority();
    const [pool] = await this.db.select({ id: runnerPools.id }).from(runnerPools)
      .innerJoin(tenantGroups, eq(tenantGroups.id, runnerPools.groupId)).leftJoin(policies, eq(policies.groupId, runnerPools.groupId))
      .leftJoin(runnerPoolLeaseEpochs, eq(runnerPoolLeaseEpochs.poolId, runnerPools.id))
      .where(and(or(isNull(policies.mode), eq(policies.mode, "legacy")), sql`coalesce(${runnerPoolLeaseEpochs.draining}, false) = false`))
      .orderBy(sql`case when ${runnerPools.id} = 'default' then 0 else 1 end`, asc(runnerPools.id)).limit(1);
    return pool?.id ?? null;
  }

  async update(groupId: string, raw: unknown, actorId: string, poolAuthenticationEnabled: boolean): Promise<GroupModelConfigurationView> {
    assertPlatformAuthority();
    const input = groupModelConfigurationInput.parse(raw);
    if (input.mode !== "legacy" && !poolAuthenticationEnabled) throw new ConflictError(
      "Pool authentication must be configured before enabling a group runtime Model policy.", "group_models_require_pool_authentication");
    return this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const [state] = await tx.select().from(controllerState).where(eq(controllerState.id, "singleton")).for("update");
      if (!state) throw unavailable();
      const [group] = await tx.select({ id: tenantGroups.id }).from(tenantGroups).where(eq(tenantGroups.id, groupId));
      if (!group) throw new NotFoundError("Tenant Group", groupId);
      const [current] = await tx.select().from(policies).where(eq(policies.groupId, groupId)).for("update");
      if ((current?.version ?? 0) !== input.expectedVersion) throw new ConflictError(
        "The group Model policy changed. Reload its current version.", "group_model_configuration_conflict");
      const version = input.expectedVersion + 1, generation = state.desiredGeneration + 1, id = randomUUID();
      if (!Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(generation) || generation < 0
        || (current && generation <= current.generation)) throw unavailable();
      const frozen = input.mode === "scoped" ? await this.freeze(tx, input.sourceRevisionId, input.expectedSourceFingerprint, id, version, generation) : null;
      const values = { groupId, id, version, generation, mode: input.mode, sourceRevisionId: input.mode === "scoped" ? input.sourceRevisionId : null,
        sourceFingerprint: frozen?.fingerprint ?? null, runtimePayload: frozen?.configuration ?? null,
        credentialCiphertexts: frozen?.credentials ?? {}, snapshotDigest: frozen?.digest ?? null,
        updatedBy: actorId, updatedAt: new Date() };
      const [saved] = current ? await tx.update(policies).set(values).where(and(eq(policies.groupId, groupId), eq(policies.version, current.version))).returning()
        : await tx.insert(policies).values(values).returning();
      if (!saved) throw unavailable();
      await tx.update(controllerState).set({ desiredGeneration: generation, updatedAt: new Date() }).where(eq(controllerState.id, "singleton"));
      await tx.insert(outboxEvents).values({ id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: groupId,
        payload: { resourceType: "group_model_configuration", groupId, generation, mode: input.mode, grantId: id } });
      await tx.insert(auditEvents).values({ id: randomUUID(), actorId, kind: "tenant_group.model_configuration_changed", resourceType: "tenant_group", resourceId: groupId,
        detail: { mode: input.mode, version, generation, grantId: id, previousGrantId: current?.id ?? null,
          sourceRevisionId: values.sourceRevisionId, sourceFingerprint: values.sourceFingerprint, snapshotDigest: values.snapshotDigest } });
      return this.publicPolicy(groupId, saved);
    });
  }

  /** Caller holds allocation/generation locks. Selection and secret retrieval
   * use the same persisted current policy, independent of later draft edits. */
  async selectionForPool(poolId: string, tx: GroupModelTransaction): Promise<GroupRuntimeSelection | null> {
    const [pool] = await tx.select({ groupId: runnerPools.groupId, policy: policies, draining: runnerPoolLeaseEpochs.draining }).from(runnerPools)
      .innerJoin(tenantGroups, eq(tenantGroups.id, runnerPools.groupId))
      .leftJoin(policies, eq(policies.groupId, runnerPools.groupId))
      .leftJoin(runnerPoolLeaseEpochs, eq(runnerPoolLeaseEpochs.poolId, runnerPools.id)).where(eq(runnerPools.id, poolId));
    if (!pool || pool.draining) return null;
    const policy = pool.policy;
    if (!policy || policy.mode === "legacy") return { groupId: pool.groupId, mode: "legacy", configuration: null };
    if (policy.mode === "blocked") return { groupId: pool.groupId, mode: "blocked", configuration: {
      revisionId: prefix + policy.id, revision: policy.version, generation: policy.generation,
      assignments: emptyModelAssignments(), models: [],
    }, credentials: {} };
    if (policy.mode !== "scoped") throw unavailable();
    const frozen = this.checkedSnapshot(policy);
    return { groupId: pool.groupId, mode: "scoped", configuration: frozen.configuration, credentials: frozen.credentials };
  }

  resolveSelectedCredentials(selection: Exclude<GroupRuntimeSelection, { mode: "legacy" }>, refs: string[]): Record<string, string> {
    if (!refs.length || refs.length > 64 || refs.some(ref => !Object.hasOwn(selection.credentials, ref))) return {};
    return Object.fromEntries([...new Set(refs)].map(ref => [ref, decryptModelCredential(selection.credentials[ref]!, this.rootSecret)]));
  }

  async assertModelUnused(modelId: string, tx: Pick<ControllerDatabase, "select"> = this.db): Promise<void> {
    const [row] = await tx.select({ id: policies.id }).from(policies).where(and(eq(policies.mode, "scoped"),
      sql`exists (select 1 from jsonb_array_elements(${policies.runtimePayload}->'models') model where model->>'id' = ${modelId})`)).limit(1);
    if (row) throw new ConflictError("Revoke the group runtime Model grant before deleting this Model.", "group_model_in_use");
  }

  async assertProviderUnused(providerId: string, tx: Pick<ControllerDatabase, "select"> = this.db): Promise<void> {
    const [row] = await tx.select({ id: policies.id }).from(policies).where(and(eq(policies.mode, "scoped"),
      sql`${policies.credentialCiphertexts} ? ${providerId}`)).limit(1);
    if (row) throw new ConflictError("Revoke the group runtime Model grant before deleting this Provider.", "group_model_provider_in_use");
  }

  private async freeze(tx: GroupModelTransaction, revisionId: string, expectedFingerprint: string, id: string, version: number, generation: number) {
    const [source] = await tx.select().from(modelConfigurationRevisions).where(eq(modelConfigurationRevisions.id, revisionId)).for("share");
    if (!source || source.tenantId !== LEGACY_TENANT_ID || !["validated", "active", "superseded"].includes(source.state)
      || !source.validatedAt || source.validationReport?.valid !== true) throw new ValidationError("Select a validated platform Model configuration revision.");
    if (source.validationReport.runtimeFingerprint !== expectedFingerprint) throw new ConflictError(
      "The reviewed Model configuration validation changed. Reload it before granting access.", "group_model_source_changed");
    const assignments = normalizeModelAssignments(source.assignments);
    assignments.controlPlane = null;
    const modelIds = [...new Set(Object.values(assignments.bindings).filter((value): value is string => Boolean(value)))];
    if (modelIds.length > 64) throw new ValidationError("Group runtime Model selection exceeds its resource bound.");
    const models = modelIds.length ? await tx.select().from(modelDefinitions).where(and(inArray(modelDefinitions.id, modelIds), isNull(modelDefinitions.tenantId))).orderBy(modelDefinitions.id).for("share") : [];
    const providerIds = [...new Set(models.map(model => model.providerId))];
    const providers = providerIds.length ? await tx.select().from(modelProviders).where(inArray(modelProviders.id, providerIds)).orderBy(modelProviders.id).for("share") : [];
    const byModel = new Map(models.map(model => [model.id, model])), byProvider = new Map(providers.map(provider => [provider.id, provider]));
    const fingerprint = modelRuntimeValidationFingerprint(assignments, models, providers);
    if (models.length !== modelIds.length || providers.some(provider => provider.status !== "validated")
      || source.validationReport.runtimeFingerprint !== fingerprint) throw new ConflictError(
        "Model configuration validation does not match the current platform runtime settings. Validate it again.", "group_model_validation_required");
    for (const binding of capabilityBindings) {
      const modelId = assignments.bindings[binding.id];
      if (!modelId) continue;
      const model = byModel.get(modelId), provider = model && byProvider.get(model.providerId);
      if (!model || !provider || !assignmentTargetAcceptsModel(binding.id, model.profile, provider.kind)
        || !source.validationReport.checks.some(check => check.id === `probe:${binding.id}:${modelId}` && check.status === "passed" && check.evidenceKind === "nemo-rail-v1"
          && check.runtimeFingerprint === modelBindingValidationFingerprint(binding.id, model, provider)))
        throw new ConflictError("Every selected runtime binding requires matching passed Rail validation.", "group_model_validation_required");
    }
    const configuration: ActiveModelConfiguration = { revisionId: prefix + id, revision: version, generation, assignments,
      models: models.map(model => { const provider = byProvider.get(model.providerId)!; return {
        id: model.id, providerId: provider.id, providerName: provider.name, baseUrl: provider.baseUrl, credentialRef: provider.id,
        skipTlsVerify: provider.skipTlsVerify, model: model.model, profile: model.profile, timeoutSeconds: model.timeoutSeconds, maxTokens: model.maxTokens, maxConcurrency: model.maxConcurrency ?? 2,
      }; }) };
    const credentials = Object.fromEntries(providers.map(provider => [provider.id, provider.credentialCiphertext]));
    const size = await tx.execute<{ bytes: number }>(sql`select octet_length(${JSON.stringify(configuration)}::jsonb::text) + octet_length(${JSON.stringify(credentials)}::jsonb::text) as bytes`);
    if (!size.rows[0] || size.rows[0].bytes > 262144) throw new ControllerError("Group runtime Model snapshot exceeds its payload budget.", 413, "group_model_snapshot_too_large");
    return { configuration, credentials, fingerprint, digest: digest({ configuration, credentials }) };
  }

  private checkedSnapshot(policy: Policy) {
    const configuration = snapshotSchema.safeParse(policy.runtimePayload), credentials = ciphertextsSchema.safeParse(policy.credentialCiphertexts);
    if (!configuration.success || !credentials.success || configuration.data.revisionId !== prefix + policy.id
      || configuration.data.assignments.controlPlane !== null || configuration.data.revision !== policy.version
      || configuration.data.generation !== policy.generation || digest({ configuration: policy.runtimePayload, credentials: policy.credentialCiphertexts }) !== policy.snapshotDigest) throw unavailable();
    const selected = new Set(Object.values(configuration.data.assignments.bindings).filter(Boolean));
    const refs = new Set(configuration.data.models.map(model => model.credentialRef));
    if (configuration.data.models.length !== selected.size || new Set(configuration.data.models.map(model => model.id)).size !== selected.size || configuration.data.models.some(model =>
      !selected.has(model.id) || model.providerId !== model.credentialRef) || refs.size !== Object.keys(credentials.data).length
      || [...refs].some(ref => !Object.hasOwn(credentials.data, ref))) throw unavailable();
    return { configuration: configuration.data, credentials: credentials.data };
  }

  private publicPolicy(groupId: string, policy?: Policy): GroupModelConfigurationView {
    const snapshot = policy?.mode === "scoped" ? this.checkedSnapshot(policy).configuration : null;
    return { groupId, mode: policy?.mode ?? "legacy", version: policy?.version ?? 0, grantId: policy?.mode === "scoped" ? policy.id : null,
      sourceRevisionId: policy?.sourceRevisionId ?? null, sourceFingerprint: policy?.sourceFingerprint ?? null, generation: policy?.generation ?? null,
      modelIds: snapshot?.models.map(model => model.id) ?? [], providerIds: [...new Set(snapshot?.models.map(model => model.providerId) ?? [])],
      updatedAt: policy?.updatedAt.toISOString() ?? null };
  }
}
