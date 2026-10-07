// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadSync } from "@grpc/proto-loader";
import { describe, expect, it, vi } from "vitest";
import { artifactFromWire } from "../control-channel/protocol-codec.js";
import type { Artifact__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/Artifact.js";
import { guardrailArtifactExport } from "../domain/guardrail-artifact-export.js";
import type { CompiledArtifactInput } from "../domain/models.js";
import type { ControllerDatabase } from "../db/client.js";
import type { ControllerConfig } from "../config.js";
import { ControlPlaneService } from "./control-plane.js";

const definitions = loadSync(resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"), {
  includeDirs: [resolve("../proto/tasklattice/guard/control/v1")], longs: String, enums: String, defaults: true, oneofs: true,
});
const desiredType = definitions["tasklattice.guard.control.v1.DesiredState"]!;
const artifactType = definitions["tasklattice.guard.control.v1.Artifact"]!;
function fixture(name: string): CompiledArtifactInput {
  if (!("deserialize" in desiredType)) throw new Error("Missing DesiredState type");
  const state = desiredType.deserialize(Buffer.from(readFileSync(resolve(`../tests/fixtures/artifacts/${name}/desired-state.pb.b64`), "utf8"), "base64"));
  const wire = state.artifacts[0] as Artifact__Output;
  return { ...artifactFromWire(wire), id: wire.artifactId, checksum: wire.checksum, signature: wire.signature } as CompiledArtifactInput;
}
function serviceWith(...rows: unknown[][]) {
  const select = vi.fn(() => {
    const builder = { from: () => builder, where: () => builder, limit: async () => rows.shift() ?? [] };
    return builder;
  });
  return { select, service: new ControlPlaneService({ select } as unknown as ControllerDatabase, {
    policyCatalogDir: "/nonexistent-policy-library",
  } as ControllerConfig) };
}

describe("Guardrail Artifact export", () => {
  it.each(readdirSync(resolve("../tests/fixtures/artifacts")))("preserves the complete signed Runner contract: %s", name => {
    const artifact = fixture(name);
    const exported = guardrailArtifactExport(artifact);
    if (!("serialize" in artifactType)) throw new Error("Missing Artifact type");
    const decoded = artifactType.deserialize(artifactType.serialize(exported)) as Artifact__Output;
    const { id: _id, checksum: _checksum, signature: _signature, ...content } = artifact;
    expect(artifactFromWire(decoded)).toEqual(content);
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
    const checksum = createHash("sha256").update(JSON.stringify(canonical(artifactFromWire(decoded)))).digest("hex");
    expect(checksum).toBe(artifact.checksum);
    expect(decoded.signature).toBe(artifact.signature);
    expect(decoded.artifactId).toBe(artifact.id);
  });

  it("reads an exact immutable version without touching draft, model configuration or Policy Library", async () => {
    const artifact = fixture("default-local-v1");
    const { service, select } = serviceWith([{ id: artifact.guardrailId }], [{ status: "ready", artifactId: artifact.id }], [artifact]);
    expect(await service.exportGuardrailVersion(artifact.guardrailId, artifact.guardrailVersion)).toEqual(guardrailArtifactExport(artifact));
    expect(select).toHaveBeenCalledTimes(3);
  });

  it.each(["compiling", "failed"])("rejects %s versions", async status => {
    const { service, select } = serviceWith([{ id: "g" }], [{ status, artifactId: null }]);
    await expect(service.exportGuardrailVersion("g", "20261007-010000.000Z")).rejects.toMatchObject({ code: "guardrail_version_not_ready" });
    expect(select).toHaveBeenCalledTimes(2);
  });

  it.each([
    { rows: [[]], code: "not_found" },
    { rows: [[{ id: "g" }], []], code: "not_found" },
    { rows: [[{ id: "g" }], [{ status: "ready", artifactId: "a" }], []], code: "guardrail_version_artifact_missing" },
  ])("rejects unavailable resources: $code", async ({ rows, code }) => {
    await expect(serviceWith(...rows).service.exportGuardrailVersion("g", "20261007-010000.000Z")).rejects.toMatchObject({ code });
  });

  it("refuses a reference-only Artifact instead of repairing it from the live Library", () => {
    const artifact = fixture("default-local-v1");
    const steps = artifact.plan.steps as Array<{ parameters: string[][]; capability: string }>;
    for (const step of steps) step.parameters = step.parameters.filter(([key]) => key !== "policy_definitions_json");
    expect(() => guardrailArtifactExport(artifact)).toThrow(/complete Policy snapshot/);
  });
});
