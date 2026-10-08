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
import { assertSelfContained, buildPackage, parsePackage, verifyPackageVersion, type UatEvidence } from "./guardrail-package.js";
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
const evidence = (content: ArtifactContent): UatEvidence => ({
  contentDigest: artifactContentDigest(content), guardrailId: content.guardrailId, version: content.guardrailVersion, source: { id: "uat", name: "UAT" },
  validationRunId: "run-1", status: "passed", testedAt: "2026-10-08T00:00:00.000Z", completedAt: "2026-10-08T00:01:00.000Z", publishedAt: "2026-10-08T00:02:00.000Z",
  sourceDraftRevision: 1, metrics: { total: 2, passed: 2 }, testSuiteDigest: "a".repeat(64), resultsDigest: "b".repeat(64), excludedCaseIds: [], runtime: null,
});
function packageOf(content: ArtifactContent) {
  const policies = ((content.plan.policy_bindings ?? []) as Array<{ policy_id: string; policy_version: string }>).map(binding => ({ policyId: binding.policy_id, policyVersion: binding.policy_version, name: binding.policy_id, source: "built_in" as const, rules: [] }));
  return buildPackage({
    source: { id: "uat", name: "UAT" }, guardrail: { id: content.guardrailId, name: "Fixture" }, recommendedVersion: content.guardrailVersion, exportedAt: new Date("2026-10-08T00:00:00.000Z"),
    versions: [{ content, evidence: evidence(content), inspection: { name: "Fixture", runtimeProfile: "auto", draftConfig: { allowedTopics: [], restrictedTopics: [], policyBindings: [], safetyLevel: "balanced", outputDelivery: "full_buffered" }, policies, testSuite: { total: 2, digest: "a".repeat(64) } } }],
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
  it.each(["default-local-v1", "custom-symbol-ownership-v1", "topic-control-native-v1"])("round-trips %s with its requirements and evidence", name => {
    const { content } = fixture(name);
    const parsed = parsePackage(packageOf(content));
    expect(parsed.versions).toHaveLength(1);
    expect(verifyPackageVersion(parsed, parsed.versions[0]!, canonicalize)).toBe(artifactContentDigest(content));
    expect(parsed.versions[0]!.requirements).toEqual(deriveRequirements(content));
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
