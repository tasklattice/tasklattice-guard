import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadSync, type MessageTypeDefinition } from "@grpc/proto-loader";
import { describe, expect, it } from "vitest";
import { artifactFromWire } from "../control-channel/protocol-codec.js";
import type { DesiredState__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/DesiredState.js";
import { artifactContentDigest, verifyArtifactDigest, type ArtifactContent } from "./artifact-content.js";
import { artifactExecutionContractIssue, PLAN_COMPILER_VERSION, NEMO_COMPILER_VERSION } from "./artifact-execution-contract.js";

describe("Artifact execution admission", () => {
  it("rejects a signed unsupported contract despite valid integrity", () => {
    const directory = resolve("../tests/fixtures/artifacts/local-secrets-v1");
    const protoPath = resolve("../proto/tasklattice/guard/control/v1/runner_control.proto");
    const type = loadSync(protoPath, { includeDirs: [dirname(protoPath)], longs: String, enums: String, defaults: true, oneofs: true })
      ["tasklattice.guard.control.v1.DesiredState"] as MessageTypeDefinition;
    const state = type.deserialize(Buffer.from(readFileSync(`${directory}/desired-state.pb.b64`, "utf8").trim(), "base64")) as DesiredState__Output;
    const wire = state.artifacts[0]!;
    const artifact = artifactFromWire(wire) as unknown as ArtifactContent;
    expect(artifactContentDigest(artifact)).toBe(wire.checksum);
    expect(verifyArtifactDigest(wire.checksum, wire.signature, readFileSync(`${directory}/public-key.pem`, "utf8"))).toBe(true);
    artifact.compilerVersion = "unsupported-compiler";
    const keys = generateKeyPairSync("ed25519");
    const checksum = artifactContentDigest(artifact);
    const signature = sign(null, Buffer.from(checksum), keys.privateKey).toString("base64");
    expect(verifyArtifactDigest(checksum, signature, keys.publicKey.export({type: "spki", format: "pem"}).toString())).toBe(true);
    expect(artifactExecutionContractIssue(artifact)).toContain("artifact_recompile_required");
  });

  it.each([[], [["evaluation_view", "implicit"]], [["evaluation_view", "original"], ["evaluation_view", "previous_output"]]])
  ("rejects missing, invalid or duplicate views under current version labels: %j", parameters => {
    const artifact = { plan: { compiler_version: PLAN_COMPILER_VERSION, steps: [] }, compilerVersion: NEMO_COMPILER_VERSION,
      actionBindings: [{ id: "check", parameters }] };
    expect(artifactExecutionContractIssue(artifact)).toContain("exactly one valid evaluation_view");
  });

  it("accepts only the current contract with explicit views", () => {
    const check = { id: "check", parameters: [["evaluation_view", "original"]] };
    const artifact = { plan: { compiler_version: PLAN_COMPILER_VERSION, steps: [check] }, compilerVersion: NEMO_COMPILER_VERSION, actionBindings: [check] };
    expect(artifactExecutionContractIssue(artifact)).toBeNull();
    expect(artifactExecutionContractIssue({ ...artifact, compilerVersion: "unsupported-compiler" })).toContain("Recompile");
    expect(artifactExecutionContractIssue({ ...artifact, plan: { ...artifact.plan, compiler_version: "unsupported-plan" } })).toContain("Recompile");
  });
});
