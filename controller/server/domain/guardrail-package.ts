import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../shared/canonical-json.js";
import { isGuardrailVersionId } from "../../shared/guardrail-version.js";
import { ARTIFACT_CONTENT_CONTRACT, artifactContentDigest, type ArtifactContent } from "./artifact-content.js";
import { deriveRequirements, type ArtifactRequirements } from "./artifact-requirements.js";
import { ControllerError } from "./errors.js";
import type { GuardrailInspection } from "./guardrail-inspection.js";
import type { ValidationRuntimeFingerprint } from "./models.js";
import { readZip, writeZip, type ZipLimits } from "./zip.js";

/**
 * A Guardrail release package carries one Guardrail's published versions
 * between isolated environments. Every file is canonical JSON, the manifest
 * pins every file by SHA-256, and signatures cover the manifest bytes. Only
 * this declared layout is accepted:
 *
 *   manifest.json, signatures.json,
 *   versions/<version>/{artifact,inspection,requirements,uat-evidence}.json
 */
export const PACKAGE_FORMAT = "tasklattice.guardrail-package";
export const PACKAGE_SCHEMA_VERSION = 1;
export const PACKAGE_UPLOAD_LIMIT_BYTES = 32 * 1024 * 1024;
export const PACKAGE_ZIP_LIMITS: ZipLimits = { maxEntries: 512, maxEntryBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 };
export const PACKAGE_FILE_EXTENSION = ".guardrail.zip";
const VERSION_FILES = ["artifact", "inspection", "requirements", "uat-evidence"] as const;

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const versionId = z.string().refine(isGuardrailVersionId, "Expected a Guardrail version ID.");
const identity = z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(200) }).strict();

const manifestSchema = z.object({
  format: z.literal(PACKAGE_FORMAT),
  schemaVersion: z.literal(PACKAGE_SCHEMA_VERSION),
  contentContract: z.literal(ARTIFACT_CONTENT_CONTRACT),
  exportedAt: z.string().datetime(),
  source: identity,
  guardrail: identity,
  recommendedVersion: versionId,
  versions: z.array(z.object({ version: versionId, contentDigest: digest, evidenceDigest: digest }).strict()).min(1).max(64),
  files: z.array(z.object({ path: z.string().min(1).max(200), sha256: digest, size: z.number().int().nonnegative() }).strict()),
}).strict();
export type PackageManifest = z.output<typeof manifestSchema>;

const signaturesSchema = z.object({
  signatures: z.array(z.object({ keyId: z.string().min(1).max(120), algorithm: z.literal("ed25519"), signature: z.string().min(1).max(200) }).strict()).min(1).max(8),
}).strict();
export type PackageSignature = z.output<typeof signaturesSchema>["signatures"][number];

const evidenceSchema = z.object({
  contentDigest: digest,
  guardrailId: z.string().min(1),
  version: versionId,
  source: identity,
  validationRunId: z.string().min(1),
  status: z.literal("passed"),
  testedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  publishedAt: z.string().datetime(),
  sourceDraftRevision: z.number().int().positive(),
  metrics: z.record(z.string(), z.unknown()),
  testSuiteDigest: digest,
  resultsDigest: digest,
  excludedCaseIds: z.array(z.string()),
  runtime: z.object({
    runnerId: z.string(), runnerVersion: z.string(), nemoVersion: z.string(), modelRevisionId: z.string(), compilerModelTypes: z.array(z.string()),
  }).strict().nullable(),
}).strict();
/** UAT test evidence for exactly one content digest. */
export type UatEvidence = z.output<typeof evidenceSchema> & { runtime: ValidationRuntimeFingerprint | null };

const artifactSchema = z.object({
  guardrailId: z.string(), guardrailVersion: z.string(), compilerVersion: z.string(), nemoVersion: z.string(), runtimeProfile: z.string(),
  plan: z.record(z.string(), z.unknown()), configYaml: z.string(), colangContent: z.string(),
  prompts: z.array(z.unknown()), actionBindings: z.array(z.unknown()), dependencyManifest: z.array(z.unknown()),
}).strict();

const inspectionSchema = z.object({
  name: z.string(), runtimeProfile: z.string(), draftConfig: z.record(z.string(), z.unknown()),
  policies: z.array(z.object({
    policyId: z.string(), policyVersion: z.string(), name: z.string(), source: z.enum(["built_in", "custom"]),
    rules: z.array(z.object({ id: z.string(), name: z.string(), action: z.string().nullable() }).strict()),
  }).strict()),
  testSuite: z.object({ total: z.number().int().nonnegative(), digest }).strict(),
}).strict();

export type PackageVersion = {
  version: string;
  content: ArtifactContent;
  inspection: GuardrailInspection;
  requirements: ArtifactRequirements;
  evidence: UatEvidence;
  /** SHA-256 of each of the version's files, keyed by file kind. */
  fileDigests: Record<(typeof VERSION_FILES)[number], string>;
};

export type ParsedPackage = {
  manifest: PackageManifest;
  manifestBytes: Buffer;
  signatures: PackageSignature[];
  versions: PackageVersion[];
};

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const jsonFile = (value: unknown) => Buffer.from(`${canonicalJson(value)}\n`, "utf8");
const versionPath = (version: string, file: (typeof VERSION_FILES)[number]) => `versions/${version}/${file}.json`;

export function packageError(message: string, code = "guardrail_package_invalid", detail: Record<string, unknown> = {}): ControllerError {
  return new ControllerError(message, 422, code, detail);
}

export function buildPackage(input: {
  source: { id: string; name: string };
  guardrail: { id: string; name: string };
  recommendedVersion: string;
  versions: Array<{ content: ArtifactContent; inspection: GuardrailInspection; evidence: UatEvidence }>;
  exportedAt: Date;
  sign: (manifest: Buffer) => PackageSignature[];
}): Buffer {
  const files = new Map<string, Buffer>();
  const versions = [...input.versions].sort((left, right) => left.content.guardrailVersion < right.content.guardrailVersion ? -1 : 1);
  for (const item of versions) {
    const version = item.content.guardrailVersion;
    files.set(versionPath(version, "artifact"), jsonFile(item.content));
    files.set(versionPath(version, "inspection"), jsonFile(item.inspection));
    files.set(versionPath(version, "requirements"), jsonFile(deriveRequirements(item.content)));
    files.set(versionPath(version, "uat-evidence"), jsonFile(item.evidence));
  }
  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    contentContract: ARTIFACT_CONTENT_CONTRACT,
    exportedAt: input.exportedAt.toISOString(),
    source: input.source,
    guardrail: input.guardrail,
    recommendedVersion: input.recommendedVersion,
    versions: versions.map(item => ({
      version: item.content.guardrailVersion,
      contentDigest: artifactContentDigest(item.content),
      evidenceDigest: sha256(files.get(versionPath(item.content.guardrailVersion, "uat-evidence"))!),
    })),
    files: [...files].sort(([left], [right]) => left < right ? -1 : 1).map(([path, bytes]) => ({ path, sha256: sha256(bytes), size: bytes.length })),
  };
  const manifestBytes = jsonFile(manifest);
  files.set("manifest.json", manifestBytes);
  files.set("signatures.json", jsonFile({ signatures: input.sign(manifestBytes) }));
  return writeZip(files);
}

/**
 * Structural verification: archive safety, the declared file set, every file
 * hash and canonical JSON shapes. Trust and semantic checks happen afterwards.
 */
export function parsePackage(archive: Buffer): ParsedPackage {
  if (archive.length > PACKAGE_UPLOAD_LIMIT_BYTES) throw packageError("The package exceeds the 32 MiB upload limit.");
  const files = readZip(archive, PACKAGE_ZIP_LIMITS);
  const manifestBytes = files.get("manifest.json");
  const signaturesBytes = files.get("signatures.json");
  if (!manifestBytes || !signaturesBytes) throw packageError("The package must contain manifest.json and signatures.json.");
  const manifest = parseJsonFile("manifest.json", manifestBytes, manifestSchema);
  const signatures = parseJsonFile("signatures.json", signaturesBytes, signaturesSchema).signatures;
  const versionIds = manifest.versions.map(item => item.version);
  if (new Set(versionIds).size !== versionIds.length) throw packageError("The manifest lists a version more than once.");
  if (!versionIds.includes(manifest.recommendedVersion)) throw packageError("The recommended version is not in the package.");
  const expected = new Set(versionIds.flatMap(version => VERSION_FILES.map(file => versionPath(version, file))));
  const declared = new Map(manifest.files.map(item => [item.path, item]));
  const present = [...files.keys()].filter(path => path !== "manifest.json" && path !== "signatures.json");
  const undeclared = present.filter(path => !expected.has(path) || !declared.has(path));
  const missing = [...expected].filter(path => !files.has(path) || !declared.has(path));
  if (undeclared.length || missing.length || declared.size !== expected.size || manifest.files.length !== expected.size) {
    throw packageError("The package contents do not match its manifest.", "guardrail_package_undeclared_content", { undeclared, missing });
  }
  for (const [path, entry] of declared) {
    const bytes = files.get(path)!;
    if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.size) throw packageError(`${path} does not match its manifest digest.`, "guardrail_package_digest_mismatch", { path });
  }
  const versions = manifest.versions.map(({ version }): PackageVersion => {
    const bytes = (file: (typeof VERSION_FILES)[number]) => files.get(versionPath(version, file))!;
    return {
      version,
      content: parseJsonFile(versionPath(version, "artifact"), bytes("artifact"), artifactSchema) as ArtifactContent,
      inspection: parseJsonFile(versionPath(version, "inspection"), bytes("inspection"), inspectionSchema) as unknown as GuardrailInspection,
      requirements: JSON.parse(bytes("requirements").toString("utf8")) as ArtifactRequirements,
      evidence: parseJsonFile(versionPath(version, "uat-evidence"), bytes("uat-evidence"), evidenceSchema) as UatEvidence,
      fileDigests: Object.fromEntries(VERSION_FILES.map(file => [file, sha256(bytes(file))])) as PackageVersion["fileDigests"],
    };
  });
  return { manifest, manifestBytes, signatures, versions };
}

/**
 * Semantic verification of one version against its manifest entry. The
 * caller supplies the transport normalization so content the Runner would
 * decode differently (undeclared fields, missing defaults) is rejected.
 */
export function verifyPackageVersion(
  parsed: ParsedPackage,
  item: PackageVersion,
  canonicalize: (content: ArtifactContent) => ArtifactContent,
): string {
  const fail = (message: string) => packageError(`Version ${item.version}: ${message}`, "guardrail_package_invalid", { version: item.version });
  const entry = parsed.manifest.versions.find(candidate => candidate.version === item.version)!;
  const content = item.content;
  if (content.guardrailId !== parsed.manifest.guardrail.id || content.guardrailVersion !== item.version
    || content.plan.guardrail_id !== content.guardrailId || content.plan.guardrail_version !== item.version) {
    throw fail("the Artifact does not belong to this Guardrail version.");
  }
  if (canonicalJson(canonicalize(content)) !== canonicalJson(content)) throw fail("the Artifact contains content the Runner contract does not carry.");
  const contentDigest = artifactContentDigest(content);
  if (contentDigest !== entry.contentDigest || item.evidence.contentDigest !== contentDigest) throw packageError(`Version ${item.version}: content digest does not match.`, "guardrail_package_digest_mismatch", { version: item.version });
  if (item.evidence.guardrailId !== content.guardrailId || item.evidence.version !== item.version || item.evidence.source.id !== parsed.manifest.source.id) {
    throw fail("the UAT evidence belongs to different content or source.");
  }
  if (item.fileDigests["uat-evidence"] !== entry.evidenceDigest) throw fail("the UAT evidence digest does not match the manifest.");
  if (canonicalJson(item.requirements) !== canonicalJson(deriveRequirements(content))) throw fail("declared requirements do not match the Artifact.");
  const bindings = new Set(((content.plan.policy_bindings ?? []) as Array<Record<string, unknown>>).map(binding => `${binding.policy_id}@${binding.policy_version}`));
  const inspected = new Set(item.inspection.policies.map(policy => `${policy.policyId}@${policy.policyVersion}`));
  if (bindings.size !== inspected.size || [...bindings].some(key => !inspected.has(key))) throw fail("the inspection snapshot describes different Policies than the Artifact executes.");
  assertSelfContained(content);
  return contentDigest;
}

/**
 * A version is self-contained only when every built-in Policy it executes
 * carries its pinned definition. A reference to a Library ID or version is
 * not enough: the receiving environment must never resolve it.
 */
export function assertSelfContained(content: ArtifactContent): void {
  const steps = (content.plan.steps ?? []) as Array<{ capability?: unknown; parameters?: unknown }>;
  for (const step of steps) {
    if (step.capability !== "builtin_content_filter") continue;
    const parameters = new Map((Array.isArray(step.parameters) ? step.parameters : [])
      .filter(Array.isArray).map(pair => [String(pair[0]), String(pair[1] ?? "")]));
    try {
      const definitions = JSON.parse(parameters.get("policy_definitions_json") ?? "null");
      const versions = JSON.parse(parameters.get("policy_versions_json") ?? "null");
      const ids = (parameters.get("policy_ids") ?? "").split(/\r?\n/).map(id => id.trim()).filter(Boolean);
      if (!ids.length || ids.some(id => !definitions?.[id]?.rules?.length || definitions[id].version !== versions?.[id])) throw new Error();
    } catch {
      throw new ControllerError(`Version ${content.guardrailVersion} lacks a complete Policy snapshot. Publish a new version before exporting.`, 409, "guardrail_export_snapshot_missing", { version: content.guardrailVersion });
    }
  }
}

function parseJsonFile<T extends z.ZodType>(path: string, bytes: Buffer, schema: T): z.output<T> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw packageError(`${path} is not valid JSON.`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw packageError(`${path} does not match the package schema.`, "guardrail_package_invalid", { path, issues: parsed.error.issues.slice(0, 5) });
  if (!jsonFile(value).equals(bytes)) throw packageError(`${path} is not in canonical form.`, "guardrail_package_invalid", { path });
  return parsed.data;
}
