-- Candidate credentials remain encrypted and expire independently of the
-- Controller that dispatched validation. This is not a serving lease.
CREATE TABLE IF NOT EXISTS "model_validation_credential_lease" (
  "id" text PRIMARY KEY NOT NULL,
  "provider_id" text NOT NULL REFERENCES "model_provider"("id") ON DELETE CASCADE,
  "credential_ciphertext" text NOT NULL,
  "pool_id" text,
  "group_id" text,
  "allocation_epoch" bigint CHECK ("allocation_epoch" >= 0),
  "runner_id" text,
  "boot_id" text,
  "control_session_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  "expires_at" timestamp with time zone NOT NULL DEFAULT (clock_timestamp() + interval '95 seconds'),
  CHECK (("pool_id" IS NULL AND "group_id" IS NULL AND "allocation_epoch" IS NULL)
    OR ("pool_id" IS NOT NULL AND "group_id" IS NOT NULL AND "allocation_epoch" IS NOT NULL)),
  CHECK (("runner_id" IS NULL AND "boot_id" IS NULL AND "control_session_id" IS NULL)
    OR ("runner_id" IS NOT NULL AND "boot_id" IS NOT NULL AND "control_session_id" IS NOT NULL AND "pool_id" IS NOT NULL)),
  CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '96 seconds')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_validation_credential_lease_expiry_idx" ON "model_validation_credential_lease" ("expires_at");
