import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../shared/canonical-json.js";
import { isGuardrailVersionId } from "../../shared/guardrail-version.js";
import { ARTIFACT_CONTENT_CONTRACT, artifactContentDigest, type ArtifactContent } from "./artifact-content.js";
import { deriveRequirements, type ArtifactRequirements } from "./artifact-requirements.js";
import { ControllerError } from "./errors.js";
import type { GuardrailDraftConfig } from "./guardrail-plan.js";
import {
  derivesFromCatalogNode,
  planBuiltInDefinitions,
  planCustomVersions,
  planPolicyEdges,
  planPolicyVersion,
  policyNodeDigest,
  snapshotChecksum,
  type PolicyNode,
} from "./policy-node.js";
import type { ProgrammablePolicySnapshot } from "../policy-studio/model.js";
import { testSuiteDigest, type FrozenTestCase } from "./test-suite.js";
import { readZip, writeZip, type ZipLimits } from "./zip.js";

/**
 * A Guardrail release package is a resource tree carried between isolated
 * environments: Guardrail versions reference Policy versions. Export carries
 * every Policy version the selected Guardrail versions use; import builds the
 * tree from its leaves up. Test reports are per run and per environment; they
 * never travel. Every file is canonical JSON, the manifest indexes the nodes,
 * the edges and every file by SHA-256, and signatures cover the manifest
 * bytes. Only this declared layout is accepted:
 *
 *   manifest.json, signatures.json,
 *   policies/<policyId>/<policyVersion>/policy.json
 *   guardrails/<guardrailId>/guardrail.json
 *   guardrails/<guardrailId>/versions/<version>/{version,test-suite,artifact,requirements}.json
 */
export const PACKAGE_FORMAT = "tasklattice.guardrail-package";
export const PACKAGE_SCHEMA_VERSION = 3;
export const PACKAGE_UPLOAD_LIMIT_BYTES = 32 * 1024 * 1024;
export const PACKAGE_ZIP_LIMITS: ZipLimits = { maxEntries: 1024, maxEntryBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 };
export const PACKAGE_FILE_EXTENSION = ".guardrail.zip";
const VERSION_FILES = ["version", "test-suite", "artifact", "requirements"] as const;
type VersionFile = (typeof VERSION_FILES)[number];

const digest = z.string().regex(/^[0-9a-f]{64}$/);
// IDs and versions become path segments: no separators, no dot segments.
const segment = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,199}$/).refine(value => !value.includes(".."), "Expected a path-safe identifier.");
const versionId = z.string().refine(isGuardrailVersionId, "Expected a Guardrail version ID.");
const identity = z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(200) }).strict();
const nodeKind = z.enum(["catalog", "programmable"]);
const edge = z.object({ id: segment, version: segment, digest }).strict();

const manifestSchema = z.object({
  format: z.literal(PACKAGE_FORMAT),
  schemaVersion: z.literal(PACKAGE_SCHEMA_VERSION),
  contentContract: z.literal(ARTIFACT_CONTENT_CONTRACT),
  exportedAt: z.string().datetime(),
  source: identity,
  policies: z.array(z.object({ id: segment, version: segment, kind: nodeKind, digest }).strict()).max(512),
  guardrail: identity.extend({ id: segment }),
  versions: z.array(z.object({ version: versionId, contentDigest: digest, testSuiteDigest: digest, policies: z.array(edge).max(256) }).strict()).min(1).max(64),
  files: z.array(z.object({ path: z.string().min(1).max(500), sha256: digest, size: z.number().int().nonnegative() }).strict()),
}).strict();
export type PackageManifest = z.output<typeof manifestSchema>;

const signaturesSchema = z.object({
  signatures: z.array(z.object({ keyId: z.string().min(1).max(120), algorithm: z.literal("ed25519"), signature: z.string().min(1).max(200) }).strict()).min(1).max(8),
}).strict();
export type PackageSignature = z.output<typeof signaturesSchema>["signatures"][number];

const policySchema = z.object({ id: segment, version: segment, kind: nodeKind, definition: z.record(z.string(), z.unknown()) }).strict();
const guardrailSchema = identity;
const versionConfigSchema = z.object({ name: z.string(), runtimeProfile: z.string(), draftConfig: z.record(z.string(), z.unknown()) }).strict();

const nullableText = z.string().nullable();
const testSuiteSchema = z.array(z.object({
  id: z.string().min(1), name: z.string(), origin: z.string(), policyId: z.string(), phase: z.string(), content: z.string(),
  expectedDecision: z.string(), trustedInstruction: z.string(), targetSource: z.string(), query: z.string(),
  groundingSources: z.array(z.string()), expectedReasoningResult: nullableText, caseType: z.string(), required: z.boolean(),
  expectedFailure: nullableText, concurrencyGroup: nullableText, sourcePolicyId: nullableText, sourcePolicyVersion: nullableText,
  sourceCaseId: nullableText, coveredRuleIds: z.array(z.string()),
  expectationOverride: z.object({
    sourcePolicyVersion: z.string(), reason: z.string(), expectedDecision: z.enum(["allow", "block", "transform", "intervene"]),
    expectedOutputContent: z.string().optional(), expectedMatches: z.array(z.object({ policyId: z.string(), ruleId: z.string() }).strict()),
  }).strict().nullable(),
}).strict()).min(1).max(5000);

const artifactSchema = z.object({
  guardrailId: z.string(), guardrailVersion: z.string(), compilerVersion: z.string(), nemoVersion: z.string(), runtimeProfile: z.string(),
  plan: z.record(z.string(), z.unknown()), configYaml: z.string(), colangContent: z.string(),
  prompts: z.array(z.unknown()), actionBindings: z.array(z.unknown()), dependencyManifest: z.array(z.unknown()),
}).strict();

/** The Guardrail's configuration when the version was published. */
export type VersionConfig = { name: string; runtimeProfile: string; draftConfig: GuardrailDraftConfig };

export type PackagePolicy = PolicyNode & { digest: string; fileDigest: string };

export type PackageVersion = {
  version: string;
  config: VersionConfig;
  content: ArtifactContent;
  requirements: ArtifactRequirements;
  /** The Test Cases frozen with this version. */
  testSuite: FrozenTestCase[];
  /** The edges to the Policy versions this version uses. */
  policies: Array<{ id: string; version: string; digest: string }>;
  /** SHA-256 of each of the version's files, keyed by file kind. */
  fileDigests: Record<VersionFile, string>;
};

export type ParsedPackage = {
  manifest: PackageManifest;
  manifestBytes: Buffer;
  signatures: PackageSignature[];
  policies: PackagePolicy[];
  versions: PackageVersion[];
};

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const jsonFile = (value: unknown) => Buffer.from(`${canonicalJson(value)}\n`, "utf8");
const policyPath = (id: string, version: string) => `policies/${id}/${version}/policy.json`;
const guardrailPath = (id: string) => `guardrails/${id}/guardrail.json`;
const versionPath = (guardrailId: string, version: string, file: VersionFile) => `guardrails/${guardrailId}/versions/${version}/${file}.json`;
const nodeKey = (node: { id: string; version: string }) => `${node.id}@${node.version}`;
const byKey = <T extends { id: string; version: string }>(left: T, right: T) => nodeKey(left) < nodeKey(right) ? -1 : nodeKey(left) > nodeKey(right) ? 1 : 0;

export function packageError(message: string, code = "guardrail_package_invalid", detail: Record<string, unknown> = {}): ControllerError {
  return new ControllerError(message, 422, code, detail);
}

/** Build a package from published versions and the Policy versions they were built from. */
export function buildPackage(input: {
  source: { id: string; name: string };
  guardrail: { id: string; name: string };
  versions: Array<{ content: ArtifactContent; config: VersionConfig; testSuite: FrozenTestCase[]; policies: PolicyNode[] }>;
  exportedAt: Date;
  sign: (manifest: Buffer) => PackageSignature[];
}): Buffer {
  const files = new Map<string, Buffer>();
  const nodes = new Map<string, PolicyNode & { digest: string }>();
  for (const node of input.versions.flatMap(item => item.policies)) {
    const digestOf = policyNodeDigest(node.definition);
    const known = nodes.get(nodeKey(node));
    if (known && known.digest !== digestOf) throw new ControllerError(`Policy ${nodeKey(node)} has different content in two selected versions.`, 409, "policy_version_conflict", { policy: nodeKey(node) });
    nodes.set(nodeKey(node), { ...node, digest: digestOf });
  }
  const policies = [...nodes.values()].sort(byKey);
  for (const node of policies) files.set(policyPath(node.id, node.version), jsonFile({ id: node.id, version: node.version, kind: node.kind, definition: node.definition }));
  files.set(guardrailPath(input.guardrail.id), jsonFile(input.guardrail));
  const versions = [...input.versions].sort((left, right) => left.content.guardrailVersion < right.content.guardrailVersion ? -1 : 1);
  for (const item of versions) {
    const version = item.content.guardrailVersion;
    files.set(versionPath(input.guardrail.id, version, "version"), jsonFile(item.config));
    files.set(versionPath(input.guardrail.id, version, "test-suite"), jsonFile(item.testSuite));
    files.set(versionPath(input.guardrail.id, version, "artifact"), jsonFile(item.content));
    files.set(versionPath(input.guardrail.id, version, "requirements"), jsonFile(deriveRequirements(item.content)));
  }
  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    contentContract: ARTIFACT_CONTENT_CONTRACT,
    exportedAt: input.exportedAt.toISOString(),
    source: input.source,
    policies: policies.map(node => ({ id: node.id, version: node.version, kind: node.kind, digest: node.digest })),
    guardrail: input.guardrail,
    versions: versions.map(item => ({
      version: item.content.guardrailVersion,
      contentDigest: artifactContentDigest(item.content),
      testSuiteDigest: testSuiteDigest(item.testSuite),
      policies: [...item.policies].sort(byKey).map(node => ({ id: node.id, version: node.version, digest: nodes.get(nodeKey(node))!.digest })),
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
 * hash, canonical JSON shapes and the tree itself (nodes, edges, digests).
 * Trust and Artifact semantics are checked afterwards.
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
  const policyKeys = manifest.policies.map(nodeKey);
  if (new Set(policyKeys).size !== policyKeys.length) throw packageError("The manifest lists a Policy version more than once.");
  const guardrailId = manifest.guardrail.id;
  const expected = new Set([
    ...manifest.policies.map(node => policyPath(node.id, node.version)),
    guardrailPath(guardrailId),
    ...versionIds.flatMap(version => VERSION_FILES.map(file => versionPath(guardrailId, version, file))),
  ]);
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
  const guardrail = parseJsonFile(guardrailPath(guardrailId), files.get(guardrailPath(guardrailId))!, guardrailSchema);
  if (canonicalJson(guardrail) !== canonicalJson(manifest.guardrail)) throw packageError("guardrail.json does not describe the manifest's Guardrail.");
  // Leaves: each Policy node is what its path and the manifest say, with that digest.
  const policies = manifest.policies.map((entry): PackagePolicy => {
    const path = policyPath(entry.id, entry.version);
    const node = parseJsonFile(path, files.get(path)!, policySchema);
    if (node.id !== entry.id || node.version !== entry.version || node.kind !== entry.kind) throw packageError(`${path} does not describe the Policy version the manifest lists.`, "guardrail_package_invalid", { path });
    if (policyNodeDigest(node.definition) !== entry.digest) throw packageError(`Policy ${nodeKey(entry)}: definition digest does not match.`, "guardrail_package_digest_mismatch", { policy: nodeKey(entry) });
    return { ...node, digest: entry.digest, fileDigest: declared.get(path)!.sha256 };
  });
  const nodes = new Map(policies.map(node => [nodeKey(node), node]));
  // Edges: every edge reaches a node with that digest, and every node is used.
  const used = new Set<string>();
  for (const item of manifest.versions) {
    for (const ref of item.policies) {
      if (nodes.get(nodeKey(ref))?.digest !== ref.digest) throw packageError(`Version ${item.version} uses Policy ${nodeKey(ref)}, which the package does not carry with that digest.`, "guardrail_package_invalid", { version: item.version, policy: nodeKey(ref) });
      used.add(nodeKey(ref));
    }
  }
  const unused = policyKeys.filter(key => !used.has(key));
  if (unused.length) throw packageError("The package carries Policy versions no Guardrail version uses.", "guardrail_package_undeclared_content", { policies: unused });
  const versions = manifest.versions.map((entry): PackageVersion => {
    const bytes = (file: VersionFile) => files.get(versionPath(guardrailId, entry.version, file))!;
    return {
      version: entry.version,
      config: parseJsonFile(versionPath(guardrailId, entry.version, "version"), bytes("version"), versionConfigSchema) as unknown as VersionConfig,
      content: parseJsonFile(versionPath(guardrailId, entry.version, "artifact"), bytes("artifact"), artifactSchema) as ArtifactContent,
      requirements: JSON.parse(bytes("requirements").toString("utf8")) as ArtifactRequirements,
      testSuite: parseJsonFile(versionPath(guardrailId, entry.version, "test-suite"), bytes("test-suite"), testSuiteSchema) as FrozenTestCase[],
      policies: entry.policies,
      fileDigests: Object.fromEntries(VERSION_FILES.map(file => [file, sha256(bytes(file))])) as PackageVersion["fileDigests"],
    };
  });
  return { manifest, manifestBytes, signatures, policies, versions };
}

/**
 * Semantic verification of one version: its Artifact, test suite and
 * requirements match the manifest, and the Artifact was built from exactly
 * the Policy versions its edges name. The caller supplies the transport
 * normalization so content the Runner would decode differently (undeclared
 * fields, missing defaults) is rejected.
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
  if (contentDigest !== entry.contentDigest) throw packageError(`Version ${item.version}: content digest does not match.`, "guardrail_package_digest_mismatch", { version: item.version });
  // The suite is the one this version was tested and published with.
  if (testSuiteDigest(item.testSuite) !== entry.testSuiteDigest) {
    throw packageError(`Version ${item.version}: the test suite does not match the one it was published with.`, "guardrail_package_digest_mismatch", { version: item.version });
  }
  if (canonicalJson(item.requirements) !== canonicalJson(deriveRequirements(content))) throw fail("declared requirements do not match the Artifact.");
  // The edges are exactly the Policy versions the Artifact binds.
  const bound = new Set(planPolicyEdges(content.plan).map(nodeKey));
  const edges = new Set(item.policies.map(nodeKey));
  if (bound.size !== edges.size || [...bound].some(key => !edges.has(key))) throw fail("its Policy versions differ from the ones the Artifact executes.");
  // And the Artifact was built from those nodes, not merely from their names.
  const nodes = new Map(parsed.policies.map(node => [nodeKey(node), node]));
  const frozen = planBuiltInDefinitions(content.plan);
  const projections = planCustomVersions(content.plan);
  for (const key of edges) {
    const node = nodes.get(key)!;
    if (node.kind === "catalog") {
      const copy = frozen.get(node.id);
      if (copy && !derivesFromCatalogNode(node.definition, copy)) throw fail(`the Artifact executes a different definition of Policy ${key}.`);
    } else {
      const snapshot = node.definition as unknown as ProgrammablePolicySnapshot;
      const projection = projections.get(key);
      if (snapshotChecksum(node.definition) !== snapshot.checksum || !projection || canonicalJson(withoutNulls(planPolicyVersion(snapshot))) !== canonicalJson(withoutNulls(projection))) {
        throw fail(`the Artifact executes a different version of Policy ${key}.`);
      }
    }
  }
  assertSelfContained(content);
  return contentDigest;
}

/** The Runner transport drops unset (null) optional fields; compare as it carries them. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, withoutNulls(item)]));
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
