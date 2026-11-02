-- Authenticated WAL delivery diagnostics only. These rows do not authorize
-- legacy/scoped freshness, safe deletion, rollout completion or workload trust.
CREATE TABLE IF NOT EXISTS "runner_telemetry_wal" (
  "runner_id" text PRIMARY KEY NOT NULL,
  "pool_id" text NOT NULL REFERENCES "runner_pool"("id"),
  "wal_id" text NOT NULL UNIQUE CHECK ("wal_id" ~ '^[0-9a-f-]{36}$'),
  "acknowledged_cursor" bigint NOT NULL DEFAULT 0,
  "produced_cursor" bigint NOT NULL DEFAULT 0,
  "last_batch_id" text,
  "last_batch_digest" text,
  "last_batch_first" bigint,
  "last_batch_last" bigint,
  "received_at" timestamp with time zone,
  "caught_up_at" timestamp with time zone,
  CHECK ("acknowledged_cursor" BETWEEN 0 AND 9007199254740991 AND
    "produced_cursor" BETWEEN "acknowledged_cursor" AND 9007199254740991),
  CHECK (("last_batch_id" IS NULL AND "last_batch_digest" IS NULL AND "last_batch_first" IS NULL AND "last_batch_last" IS NULL) OR
    ("last_batch_id" IS NOT NULL AND "last_batch_digest" ~ '^[0-9a-f]{64}$' AND "last_batch_first" >= 1 AND "last_batch_last" >= "last_batch_first" AND "last_batch_last" = "acknowledged_cursor")),
  CHECK ("caught_up_at" IS NULL OR "produced_cursor" = "acknowledged_cursor")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runner_telemetry_capability" (
  "control_session_id" text PRIMARY KEY NOT NULL REFERENCES "runner_control_session"("id"),
  "wal_id" text NOT NULL REFERENCES "runner_telemetry_wal"("wal_id"),
  "capability_hash" text NOT NULL UNIQUE CHECK ("capability_hash" ~ '^[0-9a-f]{64}$'),
  "issued_at" timestamp with time zone NOT NULL DEFAULT now()
);
