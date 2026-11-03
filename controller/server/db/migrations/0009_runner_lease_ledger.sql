-- Durable Controller-side grant history. This is groundwork only: no Runner
-- protocol or tenant/pool move currently consults these records.
CREATE TABLE IF NOT EXISTS "runner_pool_lease_epoch" (
  "pool_id" text PRIMARY KEY NOT NULL REFERENCES "runner_pool"("id"),
  "epoch" bigint NOT NULL DEFAULT 0 CHECK ("epoch" >= 0),
  "draining" boolean NOT NULL DEFAULT false,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runner_serving_grant" (
  "pool_id" text NOT NULL REFERENCES "runner_pool_lease_epoch"("pool_id"),
  "runner_id" text NOT NULL,
  "boot_id" text NOT NULL,
  "nonce" text NOT NULL,
  "epoch" bigint NOT NULL CHECK ("epoch" >= 0),
  "generation" bigint NOT NULL CHECK ("generation" >= 0),
  "duration_ms" integer NOT NULL CHECK ("duration_ms" > 0),
  "uncertainty_ms" integer NOT NULL CHECK ("uncertainty_ms" >= 0),
  "issued_at" timestamp with time zone NOT NULL,
  "conservative_expires_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("pool_id", "runner_id", "boot_id", "nonce")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runner_serving_grant_expiry_idx" ON "runner_serving_grant" ("pool_id", "epoch", "conservative_expires_at");
