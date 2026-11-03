-- A boot may reconnect to another Controller without changing its boot ID.
-- Keep stream ownership separate from boot identity and retain old sessions
-- and grants so a replacement cannot erase outstanding authority.
CREATE TABLE IF NOT EXISTS "runner_control_session" (
  "id" text PRIMARY KEY NOT NULL,
  "runner_id" text NOT NULL,
  "boot_id" text NOT NULL,
  "pool_id" text NOT NULL REFERENCES "runner_pool"("id"),
  "connected_at" timestamp with time zone NOT NULL DEFAULT now(),
  "disconnected_at" timestamp with time zone,
  "snapshot_nonce" text,
  "snapshot_generation" bigint,
  "snapshot_model_revision_id" text,
  "snapshot_epoch" bigint,
  "snapshot_group_id" text,
  "snapshot_dispatched_at" timestamp with time zone,
  "snapshot_acknowledged_at" timestamp with time zone,
  "snapshot_accepted" boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
ALTER TABLE "runner_instance" ADD COLUMN IF NOT EXISTS "control_session_id" text REFERENCES "runner_control_session"("id");
--> statement-breakpoint
ALTER TABLE "runner_serving_grant" ADD COLUMN IF NOT EXISTS "control_session_id" text REFERENCES "runner_control_session"("id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runner_control_session_runner_idx" ON "runner_control_session" ("runner_id", "boot_id");
