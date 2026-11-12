import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../controller/package.json", import.meta.url));
const { tsImport } = await import(require.resolve("tsx/esm/api"));
const { encodeArtifact } = await tsImport("../controller/server/control-channel/artifact-codec.ts", import.meta.url);
const protoPath = fileURLToPath(new URL("../proto/tasklattice/guard/control/v1/runner_control.proto", import.meta.url));

export function encodePublishedArtifact(artifact) {
  return encodeArtifact(artifact, protoPath);
}
