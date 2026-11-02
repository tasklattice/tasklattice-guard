-- No backfill: historical rows without Controller-issued provenance stay NULL.
CREATE TABLE IF NOT EXISTS "endpoint_telemetry_context" (
  "id" text PRIMARY KEY NOT NULL,
  "snapshot_key" text NOT NULL UNIQUE,
  "tenant_id" text NOT NULL,
  "group_id" text NOT NULL,
  "pool_id" text NOT NULL,
  "allocation_epoch" bigint NOT NULL CHECK ("allocation_epoch" >= 0),
  "generation" bigint NOT NULL CHECK ("generation" >= 0),
  "endpoint_id" text NOT NULL,
  "adapter" text NOT NULL,
  "verification_digest" text NOT NULL,
  "endpoint_snapshot_digest" text NOT NULL,
  "router_id" text,
  "router_revision" bigint,
  "router_snapshot_digest" text,
  "targets" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "issued_at" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  "retired_at" timestamp with time zone,
  CHECK (("router_id" IS NULL AND "router_revision" IS NULL AND "router_snapshot_digest" IS NULL)
    OR ("router_id" IS NOT NULL AND "router_revision" > 0 AND "router_snapshot_digest" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_telemetry_context_pool_idx" ON "endpoint_telemetry_context" ("pool_id", "retired_at");
--> statement-breakpoint
ALTER TABLE "runtime_event" ADD COLUMN IF NOT EXISTS "allocation_context_id" text;
--> statement-breakpoint
ALTER TABLE "model_usage_cost" ADD COLUMN IF NOT EXISTS "allocation_context_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_event_allocation_context_idx" ON "runtime_event" ("allocation_context_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_usage_cost_allocation_context_idx" ON "model_usage_cost" ("allocation_context_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_endpoint_telemetry_context() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.retired_at IS NULL OR OLD.retired_at > clock_timestamp() - interval '30 days'
      OR EXISTS (SELECT 1 FROM runtime_event WHERE allocation_context_id = OLD.id)
      OR EXISTS (SELECT 1 FROM model_usage_cost WHERE allocation_context_id = OLD.id) THEN
      RAISE EXCEPTION 'Endpoint telemetry context is active, retained or referenced';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - 'retired_at') IS DISTINCT FROM (to_jsonb(OLD) - 'retired_at')
    OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
    RAISE EXCEPTION 'Endpoint telemetry context authority is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER endpoint_telemetry_context_immutable BEFORE UPDATE OR DELETE ON "endpoint_telemetry_context"
  FOR EACH ROW EXECUTE FUNCTION protect_endpoint_telemetry_context();
