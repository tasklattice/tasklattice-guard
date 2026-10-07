import { requestController } from "./controller-api";
import { guardrailArtifactFilename } from "../../shared/guardrail-export";

export async function downloadGuardrailArtifact(id: string, version: string): Promise<void> {
  const artifact = await requestController<Record<string, unknown>>(
    `/api/v1/guardrails/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/export`,
  );
  const url = URL.createObjectURL(new Blob([JSON.stringify(artifact, null, 2) + "\n"], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = guardrailArtifactFilename(id, version);
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Allow the browser to begin the download before releasing its Blob URL.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
