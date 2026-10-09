// @vitest-environment node
import { generateKeyPairSync, sign } from "node:crypto";
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
function packageOf(content: ArtifactContent, testSuite: FrozenTestCase[] = suite) {
  const policies = ((content.plan.policy_bindings ?? []) as Array<{ policy_id: string; policy_version: string }>).map(binding => ({ policyId: binding.policy_id, policyVersion: binding.policy_version, name: binding.policy_id, source: "built_in" as const, rules: [] }));
  return buildPackage({
    source: { id: "uat", name: "UAT" }, guardrail: { id: content.guardrailId, name: "Fixture" }, exportedAt: new Date("2026-10-08T00:00:00.000Z"),
    versions: [{ content, testSuite, inspection: { name: "Fixture", runtimeProfile: "auto", draftConfig: { allowedTopics: [], restrictedTopics: [], policyBindings: [], safetyLevel: "balanced", outputDelivery: "full_buffered" }, policies, testSuite: { total: suite.length, digest: testSuiteDigest(suite) } } }],
    sign: manifest => [{ keyId: "uat", algorithm: "ed25519", signature: sign(null, manifest, keys.privateKey).toString("base64") }],
  });
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
  it.each(["default-local-v1", "custom-symbol-ownership-v1", "topic-control-native-v1"])("round-trips %s with its requirements and test suite", name => {
    const { content } = fixture(name);
    const parsed = parsePackage(packageOf(content));
    expect(parsed.versions).toHaveLength(1);
    expect(verifyPackageVersion(parsed, parsed.versions[0]!, canonicalize)).toBe(artifactContentDigest(content));
    expect(parsed.versions[0]!.requirements).toEqual(deriveRequirements(content));
    expect(parsed.versions[0]!.testSuite).toEqual(suite);
    expect(parsed.manifest.versions[0]!.testSuiteDigest).toBe(testSuiteDigest(suite));
  });

  it("rejects a test suite other than the one the version was published with", () => {
    const { content } = fixture("default-local-v1");
    const edited = suite.map(item => item.id === "a" ? { ...item, expectedDecision: "allow" } : item);
    const parsed = parsePackage(packageOf(content, edited));
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
