-- Historical telemetry predates authenticated, durable invocation provenance.
-- Keep the original assignments for operator review, but do not expose records
-- to tenants based on an assignment that cannot be established as correct.
CREATE TABLE IF NOT EXISTS "historical_telemetry_attribution" (
  "resource_type" text NOT NULL CHECK ("resource_type" IN ('runtime_event', 'model_usage_cost', 'route_assignment')),
  "resource_id" text NOT NULL,
  "previous_tenant_id" text NOT NULL,
  "quarantined_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("resource_type", "resource_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "historical_telemetry_quarantine_checkpoint" (
  "id" text PRIMARY KEY NOT NULL,
  "completed_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- The checkpoint makes rerunning this migration safe for newer records.
-- Stop older Controller writers throughout the upgrade: a legacy writer
-- restarted after this transaction could still create untrusted assignments.
DO $$
BEGIN
  LOCK TABLE "historical_telemetry_quarantine_checkpoint" IN EXCLUSIVE MODE;
  IF NOT EXISTS (SELECT 1 FROM "historical_telemetry_quarantine_checkpoint" WHERE id = '0052') THEN
    LOCK TABLE "runtime_event", "model_usage_cost", "route_assignment" IN SHARE ROW EXCLUSIVE MODE;

    INSERT INTO "historical_telemetry_attribution" ("resource_type", "resource_id", "previous_tenant_id")
      SELECT 'runtime_event', id, tenant_id FROM "runtime_event" WHERE tenant_id IS NOT NULL
      ON CONFLICT DO NOTHING;
    INSERT INTO "historical_telemetry_attribution" ("resource_type", "resource_id", "previous_tenant_id")
      SELECT 'model_usage_cost', id, tenant_id FROM "model_usage_cost" WHERE tenant_id IS NOT NULL
      ON CONFLICT DO NOTHING;
    INSERT INTO "historical_telemetry_attribution" ("resource_type", "resource_id", "previous_tenant_id")
      SELECT 'route_assignment', decision_id, tenant_id FROM "route_assignment" WHERE tenant_id IS NOT NULL
      ON CONFLICT DO NOTHING;

    UPDATE "runtime_event" SET tenant_id = NULL WHERE tenant_id IS NOT NULL;
    UPDATE "model_usage_cost" SET tenant_id = NULL WHERE tenant_id IS NOT NULL;
    UPDATE "route_assignment" SET tenant_id = NULL WHERE tenant_id IS NOT NULL;
    INSERT INTO "historical_telemetry_quarantine_checkpoint" (id) VALUES ('0052');
  END IF;
END $$;
