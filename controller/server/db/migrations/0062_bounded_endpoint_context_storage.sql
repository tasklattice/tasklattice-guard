-- Historical rows keep their original IDs and issuance generations. Duplicate
-- active Endpoint contexts require operator review; do not guess which is live.
CREATE UNIQUE INDEX "endpoint_telemetry_context_active_endpoint_idx"
  ON "endpoint_telemetry_context" ("pool_id", "endpoint_id") WHERE "retired_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "endpoint_telemetry_context_retention_idx" ON "endpoint_telemetry_context" ("retired_at", "id")
  WHERE "retired_at" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "endpoint_telemetry_context_gc_cursor" (
  "id" text PRIMARY KEY NOT NULL CHECK ("id" = 'singleton'),
  "last_retired_at" timestamp with time zone,
  "last_context_id" text,
  CHECK (("last_retired_at" IS NULL) = ("last_context_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "endpoint_telemetry_context" ADD COLUMN "payload_bytes" bigint GENERATED ALWAYS AS (
  128::bigint + octet_length("id") + octet_length("snapshot_key") + octet_length("tenant_id")
  + octet_length("group_id") + octet_length("pool_id") + octet_length("endpoint_id") + octet_length("adapter")
  + octet_length("verification_digest") + octet_length("endpoint_snapshot_digest")
  + octet_length(coalesce("router_id", '')) + octet_length(coalesce("router_snapshot_digest", ''))
  + octet_length("targets"::text)
) STORED NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_endpoint_telemetry_context() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Thirty days of replay plus the ten-minute retirement grace, rounded up
    -- conservatively. Current/referenced history is never budget eviction.
    IF OLD.retired_at IS NULL OR OLD.retired_at > clock_timestamp() - interval '31 days'
      OR EXISTS (SELECT 1 FROM runtime_event WHERE allocation_context_id = OLD.id)
      OR EXISTS (SELECT 1 FROM model_usage_cost WHERE allocation_context_id = OLD.id) THEN
      RAISE EXCEPTION 'Endpoint telemetry context is active, retained or referenced';
    END IF;
    RETURN OLD;
  END IF;
  -- Stored generated columns are computed after BEFORE triggers.
  IF (to_jsonb(NEW) - ARRAY['retired_at','payload_bytes']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['retired_at','payload_bytes'])
    OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
    RAISE EXCEPTION 'Endpoint telemetry context authority is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
