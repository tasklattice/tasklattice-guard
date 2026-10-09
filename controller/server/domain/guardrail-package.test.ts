// @vitest-environment node
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { canonicalJson } from "../../shared/canonical-json.js";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadSync } from "@grpc/proto-loader";
import { describe, expect, it } from "vitest";
import { canonicalArtifactContent } from "../control-channel/artifact-codec.js";
import { artifactFromWire } from "../control-channel/protocol-codec.js";
import type { Artifact__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/Artifact.js";
import { artifactContent, artifactContentDigest, type ArtifactContent } from "./artifact-content.js";
import { deriveRequirements } from "./artifact-requirements.js";
import { assertSelfContained, buildPackage, parsePackage, verifyPackageVersion } from "./guardrail-package.js";
import { planBuiltInDefinitions, planCustomVersions, planPolicyEdges, planPolicyVersion, policyNodeDigest, snapshotChecksum, type PolicyNode } from "./policy-node.js";
import type { ProgrammablePolicySnapshot } from "../policy-studio/model.js";
import { freezeTestSuite, testSuiteDigest, type FrozenTestCase } from "./test-suite.js";
import { readZip, writeZip } from "./zip.js";

const protoPath = resolve("../proto/tasklattice/guard/control/v1/runner_control.proto");
const desiredType = loadSync(protoPath, { includeDirs: [resolve("../proto/tasklattice/guard/control/v1")], longs: String, enums: String, defaults: true, oneofs: true })["tasklattice.guard.control.v1.DesiredState"]!;
function fixture(name: string): { content: ArtifactContent; checksum: string } {
  if (!("deserialize" in desiredType)) throw new Error("Missing DesiredState type");
  const state = desiredType.deserialize(Buffer.from(readFileSync(resolve(`../tests/fixtures/artifacts/${name}/desired-state.pb.b64`), "utf8"), "base64"));
  const wire = state.artifacts[0] as Artifact__Output;
  return { content: artifactContent(artifactFromWire(wire) as unknown as ArtifactContent), checksum: wire.checksum };
}
const keys = generateKeyPairSync("ed25519");
const suite: FrozenTestCase[] = freezeTestSuite(["a", "b"].map(id => ({
  id, name: `Case ${id}`, origin: "generated", policyId: "pii", phase: "input", content: `content ${id}`, expectedDecision: "block",
  trustedInstruction: "", targetSource: "user_input", query: "", groundingSources: [], expectedReasoningResult: null, caseType: "scenario",
  required: true, expectedFailure: null, concurrencyGroup: null, sourcePolicyId: "pii", sourcePolicyVersion: "1", sourceCaseId: id, coveredRuleIds: [],
})));
/** The Policy nodes a fixture Artifact was built from; its frozen catalog copies stand in for the catalog. */
function nodesOf(content: ArtifactContent): PolicyNode[] {
  const frozen = planBuiltInDefinitions(content.plan);
  return planPolicyEdges(content.plan).map(({ id, version }) => ({ id, version, kind: "catalog" as const, definition: frozen.get(id) ?? { id, version, name: id } }));
}
const config = { name: "Fixture", runtimeProfile: "auto", draftConfig: { allowedTopics: [], restrictedTopics: [], policyBindings: [], safetyLevel: "balanced" as const, outputDelivery: "full_buffered" as const } };
function packageOf(content: ArtifactContent, testSuite: FrozenTestCase[] = suite, policies: PolicyNode[] = nodesOf(content)) {
  return buildPackage({
    source: { id: "uat", name: "UAT" }, guardrail: { id: content.guardrailId, name: "Fixture" }, exportedAt: new Date("2026-10-08T00:00:00.000Z"),
    versions: [{ content, testSuite, config, policies }],
    sign: manifest => [{ keyId: "uat", algorithm: "ed25519", signature: sign(null, manifest, keys.privateKey).toString("base64") }],
  });
}
/** A fixture whose plan carries a Policy Studio projection, rebuilt from a full snapshot with a valid checksum. */
function programmableFixture() {
  const { content } = fixture("custom-literal-parameters-v1");
  const projection = planCustomVersions(content.plan).get("policy-a@1")!;
  const snapshot: Record<string, unknown> = {
    ...projection, description: "", owner: "uat", published_at: "2026-10-08T00:00:00.000Z", guardrail_category: "content_safety",
    parameter_schema: (projection.parameter_schema as string[][]).map(([name, kind]) => ({ name, kind, required: false, default: null, description: "" })),
    test_cases: (projection.test_cases as string[][]).map(([name, expected]) => ({ name, expected_decision: expected, content: `input for ${name}`, rail_type: "input", required: true })),
    checksum: "",
  };
  snapshot.checksum = snapshotChecksum(snapshot);
  const plan = { ...content.plan, policy_versions: [planPolicyVersion(snapshot as unknown as ProgrammablePolicySnapshot)] };
  return { content: { ...content, plan }, node: { id: "policy-a", version: "1", kind: "programmable" as const, definition: snapshot } };
}
const canonicalize = (content: ArtifactContent) => canonicalArtifactContent(content, protoPath);

describe("Artifact content digest", () => {
  it.each(readdirSync(resolve("../tests/fixtures/artifacts")))("matches the Runner digest and survives the transport unchanged: %s", name => {
    const { content, checksum } = fixture(name);
    expect(artifactContentDigest(content)).toBe(checksum);
    expect(canonicalize(content)).toEqual(content);
  });
});

describe("Guardrail release package", () => {
  it.each(["default-local-v1", "configured-phrases-v1", "topic-control-native-v1"])("round-trips %s with its Policy nodes, requirements and test suite", name => {
    const { content } = fixture(name);
    const parsed = parsePackage(packageOf(content));
    expect(parsed.versions).toHaveLength(1);
    expect(verifyPackageVersion(parsed, parsed.versions[0]!, canonicalize)).toBe(artifactContentDigest(content));
    expect(parsed.versions[0]!.requirements).toEqual(deriveRequirements(content));
    expect(parsed.versions[0]!.testSuite).toEqual(suite);
    expect(parsed.manifest.versions[0]!.testSuiteDigest).toBe(testSuiteDigest(suite));
    // The tree: every Policy version the Artifact binds is a leaf, reached by an edge with its digest.
    const nodes = nodesOf(content);
    expect(parsed.policies.map(node => `${node.id}@${node.version}`)).toEqual(nodes.map(node => `${node.id}@${node.version}`).sort());
    expect(parsed.manifest.versions[0]!.policies.map(edge => edge.digest).sort()).toEqual(nodes.map(node => policyNodeDigest(node.definition)).sort());
  });

  it("lays out the resource tree: Policy leaves, the Guardrail, then its versions", () => {
    const { content } = fixture("configured-phrases-v1");
    const paths = [...readZip(packageOf(content), { maxEntries: 64, maxEntryBytes: 1 << 24, maxTotalBytes: 1 << 26 }).keys()].sort();
    expect(paths).toEqual([
      `guardrails/${content.guardrailId}/guardrail.json`,
      ...["artifact", "requirements", "test-suite", "version"].map(file => `guardrails/${content.guardrailId}/versions/${content.guardrailVersion}/${file}.json`),
      "manifest.json",
      "policies/configured-phrase-filter/1.0.0/policy.json",
      "signatures.json",
    ]);
  });

  it("carries a Policy Studio version as its full snapshot and checks the Artifact's copy against it", () => {
    const { content, node } = programmableFixture();
    const parsed = parsePackage(packageOf(content, suite, [node]));
    expect(parsed.policies[0]!.definition).toEqual(node.definition);
    expect(verifyPackageVersion(parsed, parsed.versions[0]!, canonicalize)).toBe(artifactContentDigest(content));
    // A snapshot whose checksum no longer matches its content is refused.
    const edited = { ...node, definition: { ...node.definition, sources: [] } };
    const tampered = parsePackage(packageOf(content, suite, [edited]));
    expect(() => verifyPackageVersion(tampered, tampered.versions[0]!, canonicalize)).toThrow(/different version of Policy policy-a@1/);
  });

  it("refuses an Artifact built from another definition than its Policy node", () => {
    const { content } = fixture("default-local-v1");
    const [first, ...rest] = nodesOf(content);
    const other = { ...first!, definition: { ...first!.definition, description: "Edited elsewhere" } };
    const parsed = parsePackage(packageOf(content, suite, [other, ...rest]));
    expect(() => verifyPackageVersion(parsed, parsed.versions[0]!, canonicalize)).toThrow(/different definition of Policy/);
  });

  it("refuses edges that differ from the Policy versions the Artifact binds", () => {
    const { content } = fixture("default-local-v1");
    const parsed = parsePackage(packageOf(content, suite, nodesOf(content).slice(1)));
    expect(() => verifyPackageVersion(parsed, parsed.versions[0]!, canonicalize)).toThrow(/differ from the ones the Artifact executes/);
  });

  it("rejects a leaf no version uses and a leaf whose definition was edited", () => {
    const { content } = fixture("configured-phrases-v1");
    const files = readZip(packageOf(content), { maxEntries: 64, maxEntryBytes: 1 << 24, maxTotalBytes: 1 << 26 });
    files.set("policies/extra/1/policy.json", Buffer.from("{}\n"));
    expect(() => parsePackage(writeZip(files))).toThrow(/do not match its manifest/);
  });

  it("rejects a test suite other than the one the version was published with", () => {
    const { content } = fixture("default-local-v1");
    const files = readZip(packageOf(content), { maxEntries: 64, maxEntryBytes: 1 << 24, maxTotalBytes: 1 << 26 });
    // Swap the suite and re-index the file, leaving the version's suite digest as published.
    const path = [...files.keys()].find(item => item.endsWith("test-suite.json"))!;
    const edited = Buffer.from(`${canonicalJson(suite.map(item => item.id === "a" ? { ...item, expectedDecision: "allow" } : item))}\n`);
    files.set(path, edited);
    const manifest = JSON.parse(files.get("manifest.json")!.toString());
    manifest.files = manifest.files.map((entry: { path: string }) => entry.path === path ? { path, sha256: createHash("sha256").update(edited).digest("hex"), size: edited.length } : entry);
    files.set("manifest.json", Buffer.from(`${canonicalJson(manifest)}\n`));
    const parsed = parsePackage(writeZip(files));
    expect(() => verifyPackageVersion(parsed, parsed.versions[0]!, canonicalize)).toThrow(/test suite does not match/);
  });

  it("rejects content the Runner contract cannot carry", () => {
    const { content } = fixture("default-local-v1");
    const smuggled = { ...content, plan: { ...content.plan, undeclared_rule: "allow everything" } };
    const parsed = parsePackage(packageOf(smuggled));
    expect(() => verifyPackageVersion(parsed, parsed.versions[0]!, canonicalize)).toThrow(/does not carry/);
  });

  it("rejects a file edited after export, even if only reformatted", () => {
    const { content } = fixture("topic-control-native-v1");
    const files = readZip(packageOf(content), { maxEntries: 64, maxEntryBytes: 1 << 24, maxTotalBytes: 1 << 26 });
    const path = [...files.keys()].find(item => item.endsWith("requirements.json"))!;
    const pretty = Buffer.from(JSON.stringify(JSON.parse(files.get(path)!.toString()), null, 2));
    files.set(path, pretty);
    expect(() => parsePackage(writeZip(files))).toThrow(/does not match its manifest digest/);
  });

  it("refuses a reference-only Artifact instead of resolving it from a Library", () => {
    const { content } = fixture("default-local-v1");
    const steps = (structuredClone(content.plan.steps) as Array<{ parameters: string[][]; capability: string }>);
    for (const step of steps) step.parameters = step.parameters.filter(([key]) => key !== "policy_definitions_json");
    expect(() => assertSelfContained({ ...content, plan: { ...content.plan, steps } })).toThrow(/complete Policy snapshot/);
    expect(() => assertSelfContained(content)).not.toThrow();
  });
});
