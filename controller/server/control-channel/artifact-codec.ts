import { loadSync, type MessageTypeDefinition } from "@grpc/proto-loader";
import { dirname, resolve } from "node:path";
import type { Artifact__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/Artifact.js";
import { artifactContent, type ArtifactContent } from "../domain/artifact-content.js";
import { artifactFromWire, artifactToWire } from "./protocol-codec.js";

const artifactTypes = new Map<string, MessageTypeDefinition<unknown, unknown>>();

/** Use the same signed wire content for on-demand HTTP and control-stream delivery. */
export function encodeArtifact(value: unknown, protoPath: string): string {
  return artifactType(protoPath).serialize(artifactToWire(value)).toString("base64");
}

function artifactType(protoPath: string): MessageTypeDefinition<unknown, unknown> {
  protoPath = resolve(protoPath);
  let type = artifactTypes.get(protoPath);
  if (!type) {
    const definitions = loadSync(protoPath, {
      includeDirs: [dirname(protoPath)], keepCase: false, longs: String, enums: String, defaults: true, oneofs: true,
    });
    const candidate = definitions["tasklattice.guard.control.v1.Artifact"];
    if (!candidate || !("serialize" in candidate)) throw new Error("Control protocol has no Artifact message.");
    type = candidate as MessageTypeDefinition<unknown, unknown>;
    artifactTypes.set(protoPath, type);
  }
  return type;
}

/**
 * Normalize content to exactly what a Runner decodes from the wire. Fields the
 * transport cannot carry are dropped and absent repeated fields become empty,
 * so the Controller digest equals the Runner digest.
 */
export function canonicalArtifactContent(value: ArtifactContent, protoPath: string): ArtifactContent {
  const type = artifactType(protoPath);
  const wire = artifactToWire({ ...value, id: "", generation: "0", checksum: "", signature: "" });
  return artifactContent(artifactFromWire(type.deserialize(type.serialize(wire)) as Artifact__Output) as ArtifactContent);
}
