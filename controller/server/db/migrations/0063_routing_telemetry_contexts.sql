-- Historical assignments stay NULL; no current-owner inference or backfill.
ALTER TABLE "route_assignment" ADD COLUMN IF NOT EXISTS "allocation_context_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "route_assignment_allocation_context_idx" ON "route_assignment" ("allocation_context_id");
--> statement-breakpoint
-- Keep contexts while any authenticated operational evidence references them.
CREATE OR REPLACE FUNCTION protect_endpoint_telemetry_context() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.retired_at IS NULL OR OLD.retired_at > clock_timestamp() - interval '31 days'
      OR EXISTS (SELECT 1 FROM runtime_event WHERE allocation_context_id = OLD.id)
      OR EXISTS (SELECT 1 FROM model_usage_cost WHERE allocation_context_id = OLD.id)
      OR EXISTS (SELECT 1 FROM route_assignment WHERE allocation_context_id = OLD.id) THEN
      RAISE EXCEPTION 'Endpoint telemetry context is active, retained or referenced';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - 'retired_at' - 'payload_bytes') IS DISTINCT FROM (to_jsonb(OLD) - 'retired_at' - 'payload_bytes')
    OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
    RAISE EXCEPTION 'Endpoint telemetry context authority is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
