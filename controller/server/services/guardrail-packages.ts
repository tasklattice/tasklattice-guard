import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
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
  validationRuns,
} from "../db/schema.js";
import { artifactContent, artifactContentDigest, ARTIFACT_CONTENT_DIGEST_VERSION, signArtifactDigest, type ArtifactContent } from "../domain/artifact-content.js";
import { deriveRequirements } from "../domain/artifact-requirements.js";
import { DEFAULT_GUARDRAIL_ID } from "../domain/defaults.js";
import { summarizeAdmissions, type ArtifactAdmission, type EnvironmentCheck } from "../domain/environment-check.js";
import { ConflictError, ControllerError, NotFoundError, ValidationError } from "../domain/errors.js";
import {
  assertSelfContained,
  buildPackage,
  PACKAGE_FILE_EXTENSION,
  parsePackage,
  verifyPackageVersion,
  type ParsedPackage,
} from "../domain/guardrail-package.js";
import { testSuiteDigest, type FrozenTestCase } from "../domain/test-suite.js";
import type { GuardrailDraftConfig } from "../domain/guardrail-plan.js";
import type { RouterDraft } from "../../shared/traffic-routing.js";
import { loadPackageTrust, packageSigner, verifyPackageSignatures, type TrustedSource } from "./package-trust.js";

type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];
type VersionState = "new" | "existing" | "conflict";

/** Reserved resource IDs a package may only supply with explicit trust. */
const RESERVED_GUARDRAIL_IDS = new Set([DEFAULT_GUARDRAIL_ID]);

export type PackageVersionPreview = {
  version: string;
  state: VersionState;
  contentDigest: string;
  /** The Test Cases the version carries: run here before it is released. */
  testSuite: { total: number; digest: string };
  requirements: ReturnType<typeof deriveRequirements>;
  environment: EnvironmentCheck | null;
};

export type PackagePreview = {
  packageId: string;
  source: { id: string; name: string };
  keyId: string;
  exportedAt: string;
  guardrail: { id: string; name: string; exists: boolean };
  versions: PackageVersionPreview[];
  /** Reasons the whole package cannot be imported; empty when importable. */
  blockers: Array<{ code: string; message: string }>;
};

export class GuardrailPackageService {
  private admission: ArtifactAdmission | null = null;

  constructor(private readonly db: ControllerDatabase, private readonly config: ControllerConfig) {}

  setArtifactAdmission(admission: ArtifactAdmission): void {
    this.admission = admission;
  }

  /** Build a signed package for published versions; nothing is read from a draft or the Library. */
  async exportPackage(guardrailId: string, requested: string[] | undefined): Promise<{ filename: string; bytes: Buffer; versions: string[] }> {
    const signer = packageSigner(this.config);
    const [guardrail] = await this.db.select().from(guardrails).where(and(eq(guardrails.id, guardrailId), isNull(guardrails.deletedAt)));
    if (!guardrail) throw new NotFoundError("Guardrail", guardrailId);
    // A package names its versions explicitly; there is no implied "current" one.
    const selected = [...new Set(requested ?? [])];
    if (!selected.length) throw new ValidationError("Choose the versions to export.");
    const rows = await this.db.select().from(guardrailVersions).where(and(eq(guardrailVersions.guardrailId, guardrailId), inArray(guardrailVersions.version, selected)));
    const artifactRows = await this.db.select().from(artifacts).where(inArray(artifacts.id, rows.map(row => row.artifactId).filter((id): id is string => Boolean(id))));
    const runRows = await this.db.select().from(validationRuns).where(inArray(validationRuns.id, rows.map(row => row.validationRunId).filter((id): id is string => Boolean(id))));
    const blockers: Array<{ version: string; missing: string[] }> = [];
    const included: Array<{ content: ArtifactContent; inspection: NonNullable<typeof rows[number]["inspection"]>; testSuite: FrozenTestCase[] }> = [];
    for (const version of selected) {
      const row = rows.find(item => item.version === version);
      const artifact = artifactRows.find(item => item.id === row?.artifactId);
      const run = runRows.find(item => item.id === row?.validationRunId);
      const missing = [
        ...(!row ? ["version"] : row.status !== "ready" ? ["ready_status"] : []),
        ...(row?.origin === "imported" ? ["export_from_source_environment"] : []),
        ...(row && !artifact ? ["artifact"] : []),
        ...(artifact && artifact.contentDigestVersion !== ARTIFACT_CONTENT_DIGEST_VERSION ? ["content_digest_contract"] : []),
        ...(row && row.origin === "local" && (!run || run.status !== "passed" || run.candidateDigest !== artifact?.checksum) ? ["tested_candidate_evidence"] : []),
        ...(row && !row.inspection ? ["inspection_snapshot"] : []),
        // The suite is part of the version's definition; it travels with it.
        ...(row && (!row.testSuite || testSuiteDigest(row.testSuite) !== row.inspection?.testSuite.digest) ? ["test_suite"] : []),
      ];
      if (!missing.length && artifact) {
        try {
          assertSelfContained(artifactContent(artifact));
        } catch {
          missing.push("policy_snapshot");
        }
      }
      if (missing.length || !row || !artifact || !row.inspection || !row.testSuite) {
        blockers.push({ version, missing });
        continue;
      }
      included.push({ content: artifactContent(artifact), inspection: row.inspection, testSuite: row.testSuite });
    }
    if (blockers.length) {
      throw new ConflictError("Some selected versions cannot be exported as self-contained releases.", "guardrail_package_incomplete", { versions: blockers });
    }
    const bytes = buildPackage({
      source: { id: signer.sourceId, name: signer.sourceName },
      guardrail: { id: guardrail.id, name: guardrail.name },
      versions: included,
      exportedAt: new Date(),
      sign: signer.sign,
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
    return this.preview(id, verified, true);
  }

  async previewPackage(packageId: string): Promise<PackagePreview> {
    return this.preview(packageId, this.verify(await this.storedPackage(packageId)), false);
  }

  /** Append the selected versions atomically: all are imported or none is. */
  async importPackage(packageId: string, input: { versions?: string[] | undefined; actorId: string | null }) {
    const bytes = await this.storedPackage(packageId);
    const result = await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "guardrail-package-import");
      // Trust is re-evaluated now: a key revoked since the preview no longer counts.
      const { parsed, source, keyId, signature, digests } = this.verify(bytes);
      const manifest = parsed.manifest;
      const selected = input.versions?.length ? [...new Set(input.versions)] : manifest.versions.map(item => item.version);
      const unknown = selected.filter(version => !manifest.versions.some(item => item.version === version));
      if (unknown.length) throw new ControllerError("The selected versions are not in this package.", 422, "guardrail_package_invalid", { versions: unknown });
      const [existing] = await tx.select().from(guardrails).where(eq(guardrails.id, manifest.guardrail.id)).for("update");
      const ownership = this.ownership(manifest.guardrail.id, existing ?? null, source);
      if (ownership) throw new ConflictError(ownership.message, ownership.code, { guardrailId: manifest.guardrail.id });
      const states = await this.versionStates(tx, parsed, digests);
      const conflicts = selected.filter(version => states.get(version) === "conflict");
      if (conflicts.length) {
        throw new ConflictError("A version with the same number but different content already exists. Nothing was imported.", "guardrail_version_conflict", { versions: conflicts });
      }
      const fresh = parsed.versions.filter(item => selected.includes(item.version) && states.get(item.version) === "new")
        .sort((left, right) => left.version < right.version ? -1 : 1);
      if (!existing) {
        // An imported Guardrail has no working draft; its draft fields only
        // describe the newest version that arrived with it.
        const descriptor = [...parsed.versions].sort((left, right) => left.version < right.version ? -1 : 1).at(-1)!.inspection;
        await tx.insert(guardrails).values({
          id: manifest.guardrail.id, name: manifest.guardrail.name, origin: "imported", sourceId: source.id,
          draftConfig: descriptor.draftConfig as GuardrailDraftConfig, runtimeProfile: descriptor.runtimeProfile, status: "draft",
        });
      }
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
        await tx.insert(guardrailVersions).values({
          guardrailId: manifest.guardrail.id, version: item.version, generation: state.desiredGeneration,
          // An imported version has no draft here; 0 marks that.
          // Arrives pending: it is released only after its suite passes here.
          sourceDraftRevision: 0, status: "pending", runtimeProfile: item.inspection.runtimeProfile,
          plan: item.content.plan, artifactId: artifact.id, inspection: item.inspection, testSuite: item.testSuite, origin: "imported", createdBy: input.actorId,
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
      await tx.insert(auditEvents).values({
        id: randomUUID(), kind: "guardrail_package.imported", actorId: input.actorId, resourceType: "guardrail", resourceId: manifest.guardrail.id,
        detail: { packageId, sourceId: source.id, keyId, imported: imported.map(item => item.version), existing: existingVersions },
      });
      return { guardrailId: manifest.guardrail.id, imported: imported.map(item => item.version), existing: existingVersions };
    });
    // Record a fresh Runner load check for what just arrived, without delaying
    // the import. Routing re-checks anyway; this keeps the detail view current.
    if (this.admission) {
      void Promise.allSettled(result.imported.map(version => this.checkVersionEnvironment(result.guardrailId, version)));
    }
    return result;
  }

  /** Ask connected Runners to dry-run load a stored version and record the verdict. */
  async checkVersionEnvironment(guardrailId: string, version: string): Promise<EnvironmentCheck> {
    const [row] = await this.db.select().from(guardrailVersions).where(and(eq(guardrailVersions.guardrailId, guardrailId), eq(guardrailVersions.version, version)));
    if (!row) throw new NotFoundError("Guardrail version", `${guardrailId}@${version}`);
    const [artifact] = row.artifactId ? await this.db.select().from(artifacts).where(eq(artifacts.id, row.artifactId)) : [];
    if (!artifact) throw new ConflictError("This version has no Artifact to check.", "guardrail_version_artifact_missing");
    const check = await this.admit({ ...artifactContent(artifact), id: artifact.id, generation: artifact.generation, checksum: artifact.checksum, signature: artifact.signature });
    await this.db.transaction(async tx => {
      const [current] = await tx.select({ environmentCheck: guardrailVersions.environmentCheck }).from(guardrailVersions)
        .where(and(eq(guardrailVersions.guardrailId, guardrailId), eq(guardrailVersions.version, version))).for("update");
      await tx.update(guardrailVersions).set({ environmentCheck: check })
        .where(and(eq(guardrailVersions.guardrailId, guardrailId), eq(guardrailVersions.version, version)));
      // The default pool preloads imported versions that passed a load check,
      // so a verdict crossing "compatible" changes what Runners should hold.
      if (row.origin !== "imported" || (current?.environmentCheck?.status === "compatible") === (check.status === "compatible")) return;
      const [state] = await tx.update(controllerState).set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
        .where(eq(controllerState.id, "singleton")).returning();
      await tx.insert(outboxEvents).values({
        id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: `${guardrailId}@${version}`,
        payload: { generation: state?.desiredGeneration ?? 0, guardrailId, version, environment: check.status },
      });
    });
    return check;
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

  private async preview(packageId: string, verified: ReturnType<GuardrailPackageService["verify"]>, checkEnvironment: boolean): Promise<PackagePreview> {
    const { parsed, source, keyId, digests } = verified;
    const manifest = parsed.manifest;
    const [existing] = await this.db.select().from(guardrails).where(eq(guardrails.id, manifest.guardrail.id));
    const states = await this.versionStates(this.db, parsed, digests);
    const stored = await this.db.select({ version: guardrailVersions.version, environmentCheck: guardrailVersions.environmentCheck }).from(guardrailVersions)
      .where(eq(guardrailVersions.guardrailId, manifest.guardrail.id));
    const ownership = this.ownership(manifest.guardrail.id, existing ?? null, source);
    const conflicts = [...states].filter(([, state]) => state === "conflict").map(([version]) => version);
    const versions = await Promise.all(parsed.versions.map(async (item): Promise<PackageVersionPreview> => {
      const state = states.get(item.version)!;
      const checksum = digests.get(item.version)!;
      // Sign in memory only; nothing is stored or activated by a preview.
      const environment = state === "new" && checkEnvironment && !ownership
        ? await this.admit({ ...item.content, id: `preview-${randomUUID()}`, generation: 0, checksum, signature: signArtifactDigest(checksum, this.config.artifactSigningKeyPath) })
        : stored.find(row => row.version === item.version)?.environmentCheck ?? null;
      return { version: item.version, state, contentDigest: checksum, testSuite: item.inspection.testSuite, requirements: item.requirements, environment };
    }));
    return {
      packageId,
      source: { id: source.id, name: source.name },
      keyId,
      exportedAt: manifest.exportedAt,
      guardrail: { id: manifest.guardrail.id, name: manifest.guardrail.name, exists: Boolean(existing) },
      versions,
      blockers: [
        ...(ownership ? [{ code: ownership.code, message: ownership.message }] : []),
        ...(conflicts.length ? [{ code: "guardrail_version_conflict", message: `Versions ${conflicts.join(", ")} already exist with different content.` }] : []),
      ],
    };
  }

  /** Structural, trust and semantic verification of exact package bytes. */
  private verify(bytes: Buffer) {
    const parsed = parsePackage(bytes);
    const { source, signature } = verifyPackageSignatures(loadPackageTrust(this.config.packageTrustPath), parsed.manifest.source.id, parsed.manifestBytes, parsed.signatures);
    const digests = new Map(parsed.versions.map(item => [item.version, verifyPackageVersion(parsed, item, content => canonicalArtifactContent(content, this.config.protoPath))]));
    return { parsed, source, keyId: signature.keyId, signature, digests };
  }

  private ownership(guardrailId: string, existing: typeof guardrails.$inferSelect | null, source: TrustedSource): { code: string; message: string } | null {
    const id = guardrailId;
    if (RESERVED_GUARDRAIL_IDS.has(id) && !source.reservedGuardrailIds.includes(id)) {
      return { code: "guardrail_reserved_id", message: `Guardrail ${id} is a reserved system resource. Source ${source.id} is not authorized to supply it.` };
    }
    if (existing?.deletedAt) return { code: "guardrail_ownership_conflict", message: `Guardrail ${id} was deleted in this environment. Restore or purge it before importing.` };
    // A reserved system resource exists in every installation; an authorized
    // source adds versions to it while the resource itself stays local.
    if (RESERVED_GUARDRAIL_IDS.has(id)) return null;
    if (existing && existing.origin !== "imported") return { code: "guardrail_ownership_conflict", message: `Guardrail ${id} was created in this environment; a package cannot take it over.` };
    if (existing && existing.sourceId !== source.id) return { code: "guardrail_ownership_conflict", message: `Guardrail ${id} belongs to source ${existing.sourceId}; source ${source.id} cannot add versions to it.` };
    return null;
  }

  private async versionStates(db: Transaction | ControllerDatabase, parsed: ParsedPackage, digests: Map<string, string>): Promise<Map<string, VersionState>> {
    const id = parsed.manifest.guardrail.id;
    const versions = parsed.versions.map(item => item.version);
    const rows = await db.select({ version: guardrailVersions.version, artifactId: guardrailVersions.artifactId, origin: guardrailVersions.origin }).from(guardrailVersions)
      .where(and(eq(guardrailVersions.guardrailId, id), inArray(guardrailVersions.version, versions)));
    const provenance = await db.select().from(guardrailVersionProvenance)
      .where(and(eq(guardrailVersionProvenance.guardrailId, id), inArray(guardrailVersionProvenance.version, versions)));
    return new Map(parsed.versions.map(item => {
      const row = rows.find(candidate => candidate.version === item.version);
      if (!row) return [item.version, "new" as const];
      const origin = provenance.find(candidate => candidate.version === item.version);
      // Same content is not enough: the frozen display, requirements and test suite must match too.
      const same = origin && origin.contentDigest === digests.get(item.version) && canonicalJson(origin.fileDigests) === canonicalJson(item.fileDigests);
      return [item.version, same ? "existing" as const : "conflict" as const];
    }));
  }

  private async storedPackage(packageId: string): Promise<Buffer> {
    const [row] = await this.db.select({ content: guardrailPackages.content }).from(guardrailPackages).where(eq(guardrailPackages.id, packageId));
    if (!row) throw new NotFoundError("Guardrail package", packageId);
    return row.content;
  }
}
