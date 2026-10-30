import { resetProtectionMode } from "../../shared/protection-mode.js";
import { clearGuardrailOperationalData } from "./guardrail-operational-data.js";
import { assertGuardrailVersionCapacity, guardrailVersionLimitIssue } from "./guardrail-version-limit.js";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { canonicalJson } from "../../shared/canonical-json.js";
import type { ControllerConfig } from "../config.js";
import { canonicalArtifactContent } from "../control-channel/artifact-codec.js";
import type { ControllerDatabase } from "../db/client.js";
import { increment } from "../db/postgres-expressions.js";
import { advisoryTransactionLock } from "../db/postgres-locks.js";
import {
  artifacts,
  auditEvents,
  controllerState,
  outboxEvents,
  guardrailPackages,
  guardrails,
  guardrailVersionProvenance,
  guardrailVersions,
  policyImportedVersions,
  policyRecords,
  policyVersions,
  policyResourceVersions,
  testCases,
} from "../db/schema.js";
import { artifactContent, artifactContentDigest, ARTIFACT_CONTENT_DIGEST_VERSION, signArtifactDigest, type ArtifactContent } from "../domain/artifact-content.js";
import { deriveRequirements } from "../domain/artifact-requirements.js";
import { summarizeAdmissions, type ArtifactAdmission, type EnvironmentCheck } from "../domain/environment-check.js";
import { ConflictError, ControllerError, NotFoundError, ValidationError } from "../domain/errors.js";
import {
  assertSelfContained,
  buildPackage,
  PACKAGE_FILE_EXTENSION,
  parsePackage,
  verifyPackageVersion,
  type PackagePolicy,
  type ParsedPackage,
  type VersionConfig,
} from "../domain/guardrail-package.js";
import { guardrailInspection } from "../domain/guardrail-inspection.js";
import { frozenBuiltInDefinition, policyNodeDigest, type PolicyNode } from "../domain/policy-node.js";
import { testSuiteDigest, type FrozenTestCase } from "../domain/test-suite.js";
import type { GuardrailDraftConfig } from "../domain/guardrail-plan.js";
import type { PolicyDto } from "../policy-catalog/catalog.js";
import type { ProgrammablePolicySnapshot } from "../policy-studio/model.js";
import type { RouterDraft } from "../../shared/traffic-routing.js";

type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];
type VersionState = "new" | "existing" | "conflict";
type PolicyState = { state: VersionState; code?: string; message?: string };

const PACKAGE_SOURCE = { id: "tasklattice-guard", name: "TaskLattice Guard" };

export type PackageVersionPreview = {
  version: string;
  state: VersionState;
  contentDigest: string;
  /** The Test Cases the version carries: run here before it is released. */
  testSuite: { total: number; digest: string };
  requirements: ReturnType<typeof deriveRequirements>;
  environment: EnvironmentCheck | null;
};

/** A Policy version the package carries: a leaf of the tree, imported before the Guardrail. */
export type PackagePolicyPreview = {
  id: string;
  version: string;
  kind: PolicyNode["kind"];
  name: string;
  state: VersionState;
  digest: string;
};

export type PackagePreview = {
  packageId: string;
  source: { id: string; name: string };
  keyId: string | null;
  exportedAt: string;
  guardrail: { id: string; name: string; exists: boolean; deleted: boolean };
  policies: PackagePolicyPreview[];
  versions: PackageVersionPreview[];
  /** Reasons the whole package cannot be imported; empty when importable. */
  blockers: Array<{ code: string; message: string }>;
};

export class GuardrailPackageService {
  private admission: ArtifactAdmission | null = null;

  constructor(
    private readonly db: ControllerDatabase,
    private readonly config: ControllerConfig,
    private readonly catalog: () => readonly PolicyDto[],
  ) {}

  setArtifactAdmission(admission: ArtifactAdmission): void {
    this.admission = admission;
  }

  /** Export immutable content without deployment-specific signing or test prerequisites. */
  async exportPackage(guardrailId: string, requested: string[] | undefined): Promise<{ filename: string; bytes: Buffer; versions: string[] }> {
    const [guardrail] = await this.db.select().from(guardrails).where(and(eq(guardrails.id, guardrailId), isNull(guardrails.deletedAt)));
    if (!guardrail) throw new NotFoundError("Guardrail", guardrailId);
    // A package names its versions explicitly; there is no implied "current" one.
    const selected = [...new Set(requested ?? [])];
    if (!selected.length) throw new ValidationError("Choose the versions to export.");
    const rows = await this.db.select().from(guardrailVersions).where(and(eq(guardrailVersions.guardrailId, guardrailId), inArray(guardrailVersions.version, selected)));
    const artifactRows = await this.db.select().from(artifacts).where(inArray(artifacts.id, rows.map(row => row.artifactId).filter((id): id is string => Boolean(id))));
    const blockers: Array<{ version: string; missing: string[] }> = [];
    const included: Array<{ content: ArtifactContent; config: VersionConfig; testSuite: FrozenTestCase[]; policies: PolicyNode[] }> = [];
    for (const version of selected) {
      const row = rows.find(item => item.version === version);
      const artifact = artifactRows.find(item => item.id === row?.artifactId);
      const missing = [
        ...(!row ? ["version"] : []),
        ...(row && !artifact ? ["artifact"] : []),
        ...(artifact && artifact.contentDigestVersion !== ARTIFACT_CONTENT_DIGEST_VERSION ? ["content_digest_contract"] : []),
        ...(row && !row.inspection ? ["inspection_snapshot"] : []),
        // The suite is part of the version's definition; it travels with it.
        ...(row && (!row.testSuite || testSuiteDigest(row.testSuite) !== row.inspection?.testSuite.digest) ? ["test_suite"] : []),
        // The Policy versions it was built from travel as the tree's leaves.
        ...(row && !row.policies ? ["policy_versions"] : []),
      ];
      if (!missing.length && artifact) {
        try {
          assertSelfContained(artifactContent(artifact));
        } catch {
          missing.push("policy_snapshot");
        }
      }
      if (missing.length || !row || !artifact || !row.inspection || !row.testSuite || !row.policies) {
        blockers.push({ version, missing });
        continue;
      }
      const { name, runtimeProfile, draftConfig } = row.inspection;
      included.push({ content: artifactContent(artifact), config: { name, runtimeProfile, draftConfig }, testSuite: row.testSuite, policies: row.policies });
    }
    if (blockers.length) {
      throw new ConflictError("Some selected versions are missing content required for export.", "guardrail_package_incomplete", { versions: blockers });
    }
    const bytes = buildPackage({
      source: PACKAGE_SOURCE,
      guardrail: { id: guardrail.id, name: guardrail.name },
      versions: included,
      exportedAt: new Date(),
    });
    const filename = `${guardrail.id}-${selected.length === 1 ? selected[0] : `${selected.length}-versions`}${PACKAGE_FILE_EXTENSION}`;
    return { filename, bytes, versions: [...selected].sort() };
  }

  /** Verify an upload, keep its exact bytes, and preview what an import would do. */
  async inspectUpload(bytes: Buffer, actorId: string | null): Promise<PackagePreview> {
    const verified = this.verify(bytes);
    const id = createHash("sha256").update(bytes).digest("hex");
    await this.db.insert(guardrailPackages).values({
      id, content: bytes, sizeBytes: bytes.length, sourceId: verified.source.id, keyId: verified.keyId,
      guardrailId: verified.parsed.manifest.guardrail.id, manifest: verified.parsed.manifest, uploadedBy: actorId,
    }).onConflictDoNothing();
    return this.preview(id, verified);
  }

  async previewPackage(packageId: string): Promise<PackagePreview> {
    return this.preview(packageId, this.verify(await this.storedPackage(packageId)));
  }

  /**
   * Build the selected part of the tree from its leaves up, atomically: the
   * Policy versions first, then the Guardrail, then its versions. All of it
   * is imported or none of it is.
   */
  async importPackage(packageId: string, input: { versions?: string[] | undefined; restoreDeleted?: boolean | undefined; actorId: string | null }) {
    const bytes = await this.storedPackage(packageId);
    const result = await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "guardrail-package-import");
      // Recheck exact stored contents and conflicts inside the import transaction.
      const { parsed, source, keyId, signature, digests } = this.verify(bytes);
      const manifest = parsed.manifest;
      const selected = input.versions?.length ? [...new Set(input.versions)] : manifest.versions.map(item => item.version);
      const unknown = selected.filter(version => !manifest.versions.some(item => item.version === version));
      if (unknown.length) throw new ControllerError("The selected versions are not in this package.", 422, "guardrail_package_invalid", { versions: unknown });
      const [existing] = await tx.select().from(guardrails).where(eq(guardrails.id, manifest.guardrail.id)).for("update");
      const restored = Boolean(existing?.deletedAt);
      if (restored && !input.restoreDeleted) {
        throw new ConflictError("This Guardrail was deleted. Review the package and confirm Restore and import to restore it.", "guardrail_restore_required", { guardrailId: manifest.guardrail.id });
      }
      const states = await this.versionStates(tx, parsed, digests);
      const conflicts = selected.filter(version => states.get(version) === "conflict");
      if (conflicts.length) {
        throw new ConflictError("A version with the same number but different content already exists. Nothing was imported.", "guardrail_version_conflict", { versions: conflicts });
      }
      const fresh = parsed.versions.filter(item => selected.includes(item.version) && states.get(item.version) === "new")
        .sort((left, right) => left.version < right.version ? -1 : 1);
      await assertGuardrailVersionCapacity(tx, manifest.guardrail.id, fresh.length);

      // Leaves: every Policy version the selected Guardrail versions use.
      const needed = new Set(parsed.versions.filter(item => selected.includes(item.version)).flatMap(item => item.policies.map(ref => `${ref.id}@${ref.version}`)));
      const leaves = parsed.policies.filter(node => needed.has(`${node.id}@${node.version}`));
      const policyStates = await this.policyStates(tx, leaves);
      const blocked = leaves.filter(node => policyStates.get(node)!.state === "conflict");
      if (blocked.length) {
        const first = policyStates.get(blocked[0]!)!;
        throw new ConflictError(first.message!, first.code!, { policies: blocked.map(node => `${node.id}@${node.version}`) });
      }
      const newPolicies = leaves.filter(node => policyStates.get(node)!.state === "new");
      for (const node of newPolicies) await this.insertPolicy(tx, node, source.id, packageId, input.actorId);

      if (!existing) {
        // Seed the same editable working draft as UI creation, from the newest selected version.
        const newest = fresh.at(-1)!;
        const descriptor = newest.config;
        await tx.insert(guardrails).values({
          id: manifest.guardrail.id, name: manifest.guardrail.name, origin: "imported", sourceId: source.id,
          draftConfig: descriptor.draftConfig as GuardrailDraftConfig, runtimeProfile: descriptor.runtimeProfile, status: "draft",
        });
        const cases = draftCases(manifest.guardrail.id, newest.testSuite);
        if (cases.length) await tx.insert(testCases).values(cases);
      }
      if (restored) {
        // Also clear operational data left by installations deleted before this lifecycle was introduced.
        // Static version content remains for identity/conflict checks; every version needs a new local release.
        const cleared = await clearGuardrailOperationalData(tx, manifest.guardrail.id);
        const [state] = await tx.update(controllerState).set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
          .where(eq(controllerState.id, "singleton")).returning();
        if (!state) throw new Error("Controller state is not initialized.");
        await tx.update(guardrails).set({
          deletedAt: null, deletedBy: null, deleteReason: null, status: "draft", ...resetProtectionMode, protectionModeGeneration: state.desiredGeneration,
          desiredGeneration: state.desiredGeneration, updatedAt: new Date(),
        }).where(eq(guardrails.id, manifest.guardrail.id));
        await tx.insert(auditEvents).values({
          id: randomUUID(), kind: "guardrail.restored", actorId: input.actorId, resourceType: "guardrail", resourceId: manifest.guardrail.id,
          detail: { packageId, sourceId: source.id, reason: "package_reimport", cleared },
        });
        await tx.insert(outboxEvents).values({
          id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: manifest.guardrail.id,
          payload: { generation: state.desiredGeneration, guardrailId: manifest.guardrail.id, restored: true },
        });
      }
      const nodes = new Map(parsed.policies.map(node => [`${node.id}@${node.version}`, node]));
      const imported: Array<{ version: string; artifactId: string }> = [];
      for (const item of fresh) {
        const [state] = await tx.update(controllerState).set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
          .where(eq(controllerState.id, "singleton")).returning();
        if (!state) throw new Error("Controller state is not initialized.");
        const checksum = digests.get(item.version)!;
        const [inserted] = await tx.insert(artifacts).values({
          ...item.content, id: randomUUID(), generation: state.desiredGeneration, checksum,
          signature: signArtifactDigest(checksum, this.config.artifactSigningKeyPath),
        }).onConflictDoNothing().returning();
        // Deleting a version keeps its Artifact; re-importing reuses that row.
        const artifact = inserted ?? (await tx.select().from(artifacts).where(eq(artifacts.checksum, checksum)))[0];
        if (!artifact || artifact.guardrailId !== manifest.guardrail.id || artifact.guardrailVersion !== item.version) {
          throw new ConflictError("Artifact checksum is already bound to different content.", "artifact_checksum_conflict");
        }
        const policies = item.policies.map(ref => nodes.get(`${ref.id}@${ref.version}`)!).map(({ id, version, kind, definition }) => ({ id, version, kind, definition }));
        await tx.insert(guardrailVersions).values({
          guardrailId: manifest.guardrail.id, version: item.version, generation: state.desiredGeneration,
          // It was not published from a local draft revision.
          // Arrives pending: it is released only after its suite passes here.
          sourceDraftRevision: 0, status: "pending", runtimeProfile: item.config.runtimeProfile,
          plan: item.content.plan, artifactId: artifact.id, inspection: inspectionOf(item.config, policies, item.testSuite),
          policies, testSuite: item.testSuite, origin: "imported", createdBy: input.actorId,
          sourceSnapshot: { draftConfig: item.config.draftConfig as GuardrailDraftConfig, runtimeProfile: item.config.runtimeProfile,
            loggingLevel: "info", excludedTestCaseIds: [], testCases: draftCases(manifest.guardrail.id, item.testSuite) },
        });
        await tx.insert(guardrailVersionProvenance).values({
          guardrailId: manifest.guardrail.id, version: item.version, sourceId: source.id, sourceKeyId: keyId, contentDigest: checksum,
          fileDigests: item.fileDigests, requirements: item.requirements, sourceSignature: signature,
          packageId, importedBy: input.actorId,
        });
        imported.push({ version: item.version, artifactId: artifact.id });
      }
      await tx.update(guardrailPackages).set({ lastImportedAt: new Date() }).where(eq(guardrailPackages.id, packageId));
      const existingVersions = selected.filter(version => states.get(version) === "existing");
      const policySummary = {
        imported: newPolicies.map(node => `${node.id}@${node.version}`),
        existing: leaves.filter(node => policyStates.get(node)!.state === "existing").map(node => `${node.id}@${node.version}`),
      };
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail_package.imported", actorId: input.actorId, resourceType: "guardrail", resourceId: manifest.guardrail.id,
        detail: { packageId, sourceId: source.id, keyId, restored, imported: imported.map(item => item.version), existing: existingVersions, policies: policySummary },
      });
      return { guardrailId: manifest.guardrail.id, restored, imported: imported.map(item => item.version), existing: existingVersions, policies: policySummary };
    });
    return result;
  }

  /**
   * Whether each Policy version is new here, already here with the same
   * definition, or in conflict: the same ID@version has different content.
   */
  private async policyStates(db: Transaction | ControllerDatabase, leaves: PackagePolicy[]): Promise<Map<PackagePolicy, PolicyState>> {
    const catalog = new Map(this.catalog().flatMap(policy => [policy, ...(policy.published_versions ?? [])]).map(policy => [`${policy.id}@${policy.version}`, policy]));
    const ids = [...new Set(leaves.map(node => node.id))];
    const maintained = ids.length ? await db.select().from(policyResourceVersions).where(inArray(policyResourceVersions.policyId, ids)) : [];
    for (const item of maintained) catalog.set(`${item.policyId}@${item.version}`, item.view);
    const imported = ids.length ? await db.select().from(policyImportedVersions).where(inArray(policyImportedVersions.policyId, ids)) : [];
    const versions = ids.length ? await db.select({ policyId: policyVersions.policyId, version: policyVersions.version, checksum: policyVersions.checksum }).from(policyVersions).where(inArray(policyVersions.policyId, ids)) : [];
    const changed = (node: PackagePolicy): PolicyState => ({ state: "conflict", code: "policy_version_conflict",
      message: `Policy ${node.id} version ${node.version} already exists here with different content. Nothing was imported.` });
    return new Map(leaves.map((node): [PackagePolicy, PolicyState] => {
      const key = `${node.id}@${node.version}`;
      if (node.kind === "catalog") {
        // Compared with what this installation's catalog would freeze for the same version.
        const shipped = catalog.get(key);
        if (shipped) return [node, policyNodeDigest(frozenBuiltInDefinition(shipped)) === node.digest ? { state: "existing" } : changed(node)];
        const kept = imported.find(row => row.policyId === node.id && row.version === node.version);
        if (kept) return [node, kept.digest === node.digest ? { state: "existing" } : changed(node)];
        return [node, { state: "new" }];
      }
      const snapshot = node.definition as unknown as ProgrammablePolicySnapshot;
      const stored = versions.find(row => row.policyId === node.id && String(row.version) === node.version);
      if (stored) return [node, stored.checksum === snapshot.checksum ? { state: "existing" } : changed(node)];
      if (catalog.has(key) || [...catalog.values()].some(policy => policy.id === node.id)) return [node, { state: "conflict", code: "policy_ownership_conflict", message: `Policy ${node.id} is a catalog Policy here; a package cannot replace it with a Policy Studio version.` }];
      return [node, { state: "new" }];
    }));
  }

  /** Add one Policy version to this environment's Library, owned by its source and read only. */
  private async insertPolicy(tx: Transaction, node: PackagePolicy, sourceId: string, packageId: string, actorId: string | null): Promise<void> {
    if (node.kind === "catalog") {
      await tx.insert(policyImportedVersions).values({ policyId: node.id, version: node.version, digest: node.digest, definition: node.definition, sourceId, packageId, importedBy: actorId });
      return;
    }
    const snapshot = node.definition as unknown as ProgrammablePolicySnapshot;
    if (!/^\d+$/.test(node.version)) throw new ControllerError(`Policy ${node.id}: version ${node.version} is not a Policy Studio version number.`, 422, "guardrail_package_invalid");
    const { policy_id: _id, version: _version, name, description, source: _source, owner, checksum, published_at: publishedAt, ...draft } = snapshot;
    const [record] = await tx.select().from(policyRecords).where(eq(policyRecords.id, node.id)).for("update");
    if (!record) {
      await tx.insert(policyRecords).values({ id: node.id, name, description, source: "custom", origin: "imported", sourceId, owner, draft: draft as unknown as typeof policyRecords.$inferInsert["draft"] });
    } else if (record.origin === "imported" && Number(node.version) > Math.max(0, ...(await tx.select({ version: policyVersions.version }).from(policyVersions).where(eq(policyVersions.policyId, node.id))).map(row => row.version))) {
      // The record describes its newest version; it is never edited here.
      await tx.update(policyRecords).set({ name, description, owner, draft: draft as unknown as typeof policyRecords.$inferInsert["draft"], updatedAt: new Date() }).where(eq(policyRecords.id, node.id));
    }
    await tx.insert(policyVersions).values({ policyId: node.id, version: Number(node.version), sourceDraftRevision: null, snapshot, checksum, publishedAt: new Date(publishedAt) });
  }

  /** Ask connected Runners to dry-run load a stored version and record the verdict. */
  async checkVersionEnvironment(guardrailId: string, version: string): Promise<EnvironmentCheck> {
    const [installation] = await this.db.select().from(guardrails).where(and(eq(guardrails.id, guardrailId), isNull(guardrails.deletedAt)));
    if (!installation) throw new NotFoundError("Guardrail", guardrailId);
    const [row] = await this.db.select().from(guardrailVersions).where(and(eq(guardrailVersions.guardrailId, guardrailId), eq(guardrailVersions.version, version)));
    if (!row) throw new NotFoundError("Guardrail version", `${guardrailId}@${version}`);
    const [artifact] = row.artifactId ? await this.db.select().from(artifacts).where(eq(artifacts.id, row.artifactId)) : [];
    if (!artifact) throw new ConflictError("This version has no Artifact to check.", "guardrail_version_artifact_missing");
    const check = await this.admit({ ...artifactContent(artifact), id: artifact.id, generation: artifact.generation, checksum: artifact.checksum, signature: artifact.signature });
    await this.db.transaction(async tx => {
      const [active] = await tx.select().from(guardrails).where(eq(guardrails.id, guardrailId)).for("share");
      if (!active || active.deletedAt || active.operationalResetAt?.getTime() !== installation.operationalResetAt?.getTime()) {
        throw new ConflictError("This Guardrail was deleted or restored during the check. Run a new environment check.", "guardrail_lifecycle_changed");
      }
      const [current] = await tx.select({ environmentCheck: guardrailVersions.environmentCheck }).from(guardrailVersions)
        .where(and(eq(guardrailVersions.guardrailId, guardrailId), eq(guardrailVersions.version, version))).for("update");
      await tx.update(guardrailVersions).set({ environmentCheck: check })
        .where(and(eq(guardrailVersions.guardrailId, guardrailId), eq(guardrailVersions.version, version)));
      // The default pool preloads published versions that passed a load check,
      // so a verdict crossing "compatible" changes what Runners should hold.
      if ((current?.environmentCheck?.status === "compatible") === (check.status === "compatible")) return;
      const [state] = await tx.update(controllerState).set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton")).returning();
      await tx.insert(outboxEvents).values({
        id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: `${guardrailId}@${version}`,
        payload: { generation: state?.desiredGeneration ?? 0, guardrailId, version, environment: check.status },
      });
    });
    return check;
  }

  private checkingEnvironments = false;

  /** Published content is checked asynchronously; missing dependencies never undo publication. */
  async checkPendingEnvironments(): Promise<void> {
    if (!this.admission || this.checkingEnvironments) return;
    this.checkingEnvironments = true;
    try {
      const rows = await this.db.select({ id: guardrailVersions.guardrailId, version: guardrailVersions.version })
        .from(guardrailVersions).innerJoin(guardrails, and(eq(guardrails.id, guardrailVersions.guardrailId), isNull(guardrails.deletedAt)))
        .where(and(eq(guardrailVersions.status, "ready"), or(isNull(guardrailVersions.environmentCheck),
          sql`(${guardrailVersions.environmentCheck}->>'status' <> 'compatible' AND (${guardrailVersions.environmentCheck}->>'checkedAt')::timestamptz < now() - interval '30 seconds')`)))
        .orderBy(sql`${guardrailVersions.environmentCheck}->>'checkedAt' ASC NULLS FIRST`, asc(guardrailVersions.createdAt)).limit(2);
      // Do not declare the job idle (or drained during shutdown) while a sibling
      // check can still make admission requests and write its database result.
      const results = await Promise.allSettled(rows.map(row => this.checkVersionEnvironment(row.id, row.version)));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } finally { this.checkingEnvironments = false; }
  }

  /**
   * Refresh Runner load checks for every imported version a Router change
   * would send traffic to. Runs outside the routing transaction; the routing
   * service then requires a recent compatible result.
   */
  async checkRoutedImports(snapshot: RouterDraft): Promise<void> {
    const targets = snapshot.routes.filter(route => route.enabled).flatMap(route => route.targets.filter(target => target.weightBps > 0));
    if (!targets.length) return;
    const ids = [...new Set(targets.map(target => target.guardrailId))];
    const rows = await this.db.select({ guardrailId: guardrailVersions.guardrailId, version: guardrailVersions.version, origin: guardrailVersions.origin })
      .from(guardrailVersions).where(inArray(guardrailVersions.guardrailId, ids));
    const routed = new Set(targets.map(target => `${target.guardrailId}\u0000${target.guardrailVersion}`));
    await Promise.all(rows.filter(row => row.origin === "imported" && routed.has(`${row.guardrailId}\u0000${row.version}`))
      .map(row => this.checkVersionEnvironment(row.guardrailId, row.version)));
  }

  private async admit(artifact: Parameters<ArtifactAdmission>[0]): Promise<EnvironmentCheck> {
    if (!this.admission) return summarizeAdmissions([]);
    return summarizeAdmissions(await this.admission(artifact));
  }

  private async preview(packageId: string, verified: ReturnType<GuardrailPackageService["verify"]>): Promise<PackagePreview> {
    const { parsed, source, keyId, digests } = verified;
    const manifest = parsed.manifest;
    const [existing] = await this.db.select().from(guardrails).where(eq(guardrails.id, manifest.guardrail.id));
    const states = await this.versionStates(this.db, parsed, digests);
    const stored = await this.db.select({ version: guardrailVersions.version }).from(guardrailVersions)
      .where(eq(guardrailVersions.guardrailId, manifest.guardrail.id));
    const conflicts = [...states].filter(([, state]) => state === "conflict").map(([version]) => version);
    const versions = parsed.versions.map((item): PackageVersionPreview => {
      const state = states.get(item.version)!;
      const checksum = digests.get(item.version)!;
      return { version: item.version, state, contentDigest: checksum, testSuite: { total: item.testSuite.length, digest: testSuiteDigest(item.testSuite) }, requirements: item.requirements, environment: null };
    });
    const policyStates = await this.policyStates(this.db, parsed.policies);
    const policies = parsed.policies.map((node): PackagePolicyPreview => ({
      id: node.id, version: node.version, kind: node.kind, name: typeof node.definition.name === "string" ? node.definition.name : node.id,
      state: policyStates.get(node)!.state, digest: node.digest,
    }));
    const policyBlockers = [...policyStates.values()].filter(item => item.state === "conflict");
    const capacityIssue = guardrailVersionLimitIssue(stored.length, versions.filter(item => item.state === "new").length);
    return {
      packageId,
      source: { id: source.id, name: source.name },
      keyId,
      exportedAt: manifest.exportedAt,
      guardrail: { id: manifest.guardrail.id, name: manifest.guardrail.name, exists: Boolean(existing), deleted: Boolean(existing?.deletedAt) },
      policies,
      versions,
      blockers: [
        ...(capacityIssue ? [{ code: capacityIssue.code, message: capacityIssue.message }] : []),
        ...policyBlockers.map(item => ({ code: item.code!, message: item.message! })),
        ...(conflicts.length ? [{ code: "guardrail_version_conflict", message: `Versions ${conflicts.join(", ")} already exist with different content.` }] : []),
      ],
    };
  }

  /** Structural and semantic verification; source labels never authorize or block imports. */
  private verify(bytes: Buffer) {
    const parsed = parsePackage(bytes);
    const source = parsed.manifest.source;
    const digests = new Map(parsed.versions.map(item => [item.version, verifyPackageVersion(parsed, item, content => canonicalArtifactContent(content, this.config.protoPath))]));
    return { parsed, source, keyId: null, signature: null, digests };
  }

  private async versionStates(db: Transaction | ControllerDatabase, parsed: ParsedPackage, digests: Map<string, string>): Promise<Map<string, VersionState>> {
    const id = parsed.manifest.guardrail.id;
    const versions = parsed.versions.map(item => item.version);
    const rows = await db.select().from(guardrailVersions)
      .where(and(eq(guardrailVersions.guardrailId, id), inArray(guardrailVersions.version, versions)));
    const contents = rows.length ? await db.select({ id: artifacts.id, checksum: artifacts.checksum }).from(artifacts)
      .where(inArray(artifacts.id, rows.flatMap(row => row.artifactId ? [row.artifactId] : []))) : [];
    const policyDigests = (nodes: PolicyNode[]) => nodes.map(node => `${node.id}@${node.version}:${policyNodeDigest(node.definition)}`).sort();
    return new Map(parsed.versions.map(item => {
      const row = rows.find(candidate => candidate.version === item.version);
      if (!row) return [item.version, "new" as const];
      const content = contents.find(candidate => candidate.id === row.artifactId);
      const inspection = row.inspection;
      const config = inspection && { name: inspection.name, runtimeProfile: inspection.runtimeProfile, draftConfig: inspection.draftConfig };
      // Round trips work for locally created and imported versions alike. Never overwrite a different definition.
      const same = content?.checksum === digests.get(item.version)
        && canonicalJson(config) === canonicalJson(item.config)
        && row.testSuite && testSuiteDigest(row.testSuite) === testSuiteDigest(item.testSuite)
        && row.policies && canonicalJson(policyDigests(row.policies)) === canonicalJson(item.policies.map(ref => `${ref.id}@${ref.version}:${ref.digest}`).sort());
      return [item.version, same ? "existing" as const : "conflict" as const];
    }));
  }

  private async storedPackage(packageId: string): Promise<Buffer> {
    const [row] = await this.db.select({ content: guardrailPackages.content }).from(guardrailPackages).where(eq(guardrailPackages.id, packageId));
    if (!row) throw new NotFoundError("Guardrail package", packageId);
    return row.content;
  }
}

/** What a version contains, for reading without a Policy Library: rebuilt from the tree. */
function inspectionOf(config: VersionConfig, policies: PolicyNode[], testSuite: FrozenTestCase[]) {
  return guardrailInspection({
    name: config.name, runtimeProfile: config.runtimeProfile, draftConfig: config.draftConfig,
    catalog: policies.filter(node => node.kind === "catalog").map(node => node.definition as unknown as PolicyDto),
    programmablePolicies: policies.filter(node => node.kind === "programmable").map(node => node.definition as unknown as ProgrammablePolicySnapshot),
    testSuite,
  });
}

/** A version freezes effective expectations; the working copy remains independently editable. */
function draftCases(guardrailId: string, suite: FrozenTestCase[]): Array<typeof testCases.$inferInsert> {
  return suite.map(({ expectationOverride: _override, ...item }) => ({ ...item, guardrailId }));
}
