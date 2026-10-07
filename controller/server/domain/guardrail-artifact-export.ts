import { artifactToWire } from "../control-channel/protocol-codec.js";
import { ConflictError } from "./errors.js";
import type { CompiledArtifactInput } from "./models.js";

/** Export the same Artifact contract consumed by the Runner, as Protobuf JSON. */
export function guardrailArtifactExport(artifact: CompiledArtifactInput) {
  const wire = artifactToWire(artifact);
  for (const step of wire.plan?.steps ?? []) {
    if (step.capability !== "builtin_content_filter") continue;
    const parameters: Record<string, string> = Object.fromEntries((step.parameters ?? []).map(pair => [String(pair.key), String(pair.value ?? "")]));
    try {
      const definitions = JSON.parse(parameters.policy_definitions_json ?? "null");
      const versions = JSON.parse(parameters.policy_versions_json ?? "null");
      const ids = (parameters.policy_ids ?? "").split(/\r?\n/).map(id => id.trim()).filter(Boolean);
      if (!ids.length || ids.some(id => !definitions?.[id]?.rules?.length || definitions[id].version !== versions?.[id])) {
        throw new Error("Missing pinned Policy implementation");
      }
    } catch {
      throw new ConflictError("This version lacks a complete Policy snapshot. Publish a new version before exporting.", "guardrail_export_snapshot_missing");
    }
  }
  return { ...wire, generation: String(artifact.generation) };
}
