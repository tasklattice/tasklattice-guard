ALTER TABLE "traffic_router_revision" ADD COLUMN "request_digest" text;
ALTER TABLE "traffic_router_revision" ADD COLUMN "generation" bigint;
CREATE TABLE "model_assignment_validation" (
  "id" text PRIMARY KEY NOT NULL,
  "actor_id" text NOT NULL REFERENCES "auth_user"("id") ON DELETE CASCADE,
  "target" text NOT NULL,
  "model_id" text NOT NULL REFERENCES "model_definition"("id") ON DELETE CASCADE,
  "fingerprint" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "model_assignment_validation_lookup_idx" ON "model_assignment_validation" ("actor_id", "target", "model_id", "created_at");
