export function guardrailArtifactFilename(id: string, version: string): string {
  return `${id}-${version}`.replace(/[^a-zA-Z0-9._-]/g, "_") + ".artifact.json";
}
