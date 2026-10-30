/** Publication provenance is audit information, never a test or runtime gate. */
export type GuardrailPublication = {
  source: "user" | "deployment";
  actorId: string | null;
  createdAt: string;
};
