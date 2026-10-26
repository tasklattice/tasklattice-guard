/** Publication provenance is audit information, never a test or runtime gate. */
export type GuardrailPublication = {
  source: "user" | "deployment" | "legacy";
  actorId: string | null;
  createdAt: string;
  legacy?: Record<string, unknown>;
};
