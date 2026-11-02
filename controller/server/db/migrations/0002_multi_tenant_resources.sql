-- Tenant resources build on the unchanged upstream schema and platform role model.
CREATE TABLE IF NOT EXISTS "tenant" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "tenant" ("id", "name") VALUES
  ('tenantA', 'Tenant A'),
  ('tenantB', 'Group B'),
  ('tenantC', 'Group C') ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN IF NOT EXISTS "tenant_id" text DEFAULT 'tenantA' NOT NULL REFERENCES "tenant"("id");
--> statement-breakpoint
ALTER TABLE "model_definition" ADD COLUMN IF NOT EXISTS "tenant_id" text REFERENCES "tenant"("id");
--> statement-breakpoint
ALTER TABLE "model_configuration_revision" ADD COLUMN IF NOT EXISTS "tenant_id" text DEFAULT 'tenantA' NOT NULL REFERENCES "tenant"("id");
--> statement-breakpoint
ALTER TABLE "policy_resource" ADD COLUMN IF NOT EXISTS "tenant_id" text DEFAULT 'tenantA' NOT NULL REFERENCES "tenant"("id");
--> statement-breakpoint
ALTER TABLE "policy_record" ADD COLUMN IF NOT EXISTS "tenant_id" text DEFAULT 'tenantA' NOT NULL REFERENCES "tenant"("id");
--> statement-breakpoint
ALTER TABLE "guardrail" ADD COLUMN IF NOT EXISTS "tenant_id" text DEFAULT 'tenantA' NOT NULL REFERENCES "tenant"("id");
--> statement-breakpoint
ALTER TABLE "traffic_router" ADD COLUMN IF NOT EXISTS "tenant_id" text DEFAULT 'tenantA' NOT NULL REFERENCES "tenant"("id");
--> statement-breakpoint
ALTER TABLE "route_assignment" ADD COLUMN IF NOT EXISTS "tenant_id" text DEFAULT 'tenantA' NOT NULL REFERENCES "tenant"("id");
--> statement-breakpoint
ALTER TABLE "endpoint" ADD COLUMN IF NOT EXISTS "tenant_id" text DEFAULT 'tenantA' NOT NULL REFERENCES "tenant"("id");
--> statement-breakpoint
ALTER TABLE "runtime_event" ADD COLUMN IF NOT EXISTS "tenant_id" text DEFAULT 'tenantA' NOT NULL REFERENCES "tenant"("id");
--> statement-breakpoint
ALTER TABLE "audit_event" ADD COLUMN IF NOT EXISTS "tenant_id" text DEFAULT 'tenantA' NOT NULL REFERENCES "tenant"("id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resource_share" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_tenant_id" text NOT NULL REFERENCES "tenant"("id") ON DELETE CASCADE,
  "recipient_tenant_id" text NOT NULL REFERENCES "tenant"("id") ON DELETE CASCADE,
  "resource_type" text NOT NULL,
  "resource_id" text NOT NULL,
  "created_by" text REFERENCES "auth_user"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "resource_share_distinct_tenants" CHECK ("owner_tenant_id" <> "recipient_tenant_id"),
  CONSTRAINT "resource_share_kind" CHECK ("resource_type" IN ('policy', 'guardrail', 'endpoint', 'router', 'model'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resource_share_unique_idx" ON "resource_share" ("owner_tenant_id", "recipient_tenant_id", "resource_type", "resource_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_share_owner_idx" ON "resource_share" ("owner_tenant_id", "resource_type", "resource_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_record_tenant_idx" ON "policy_record" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guardrail_tenant_idx" ON "guardrail" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "traffic_router_tenant_idx" ON "traffic_router" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "route_assignment_tenant_router_time_idx" ON "route_assignment" ("tenant_id", "router_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_tenant_idx" ON "endpoint" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_definition_tenant_idx" ON "model_definition" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_event_tenant_time_idx" ON "runtime_event" ("tenant_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_tenant_time_idx" ON "audit_event" ("tenant_id", "occurred_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "set_audit_event_tenant"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.actor_id IS NOT NULL THEN
    NEW.tenant_id := (SELECT tenant_id FROM auth_user WHERE id = NEW.actor_id);
  ELSIF NEW.resource_type = 'guardrail' THEN
    NEW.tenant_id := COALESCE((SELECT tenant_id FROM guardrail WHERE id = NEW.resource_id), 'tenantA');
  ELSIF NEW.resource_type = 'endpoint' THEN
    NEW.tenant_id := COALESCE((SELECT tenant_id FROM endpoint WHERE id = NEW.resource_id), 'tenantA');
  ELSIF NEW.resource_type = 'policy' THEN
    NEW.tenant_id := COALESCE((SELECT tenant_id FROM policy_resource WHERE id = NEW.resource_id), (SELECT tenant_id FROM policy_record WHERE id = NEW.resource_id), 'tenantA');
  ELSIF NEW.resource_type = 'model' THEN
    NEW.tenant_id := COALESCE((SELECT tenant_id FROM model_definition WHERE id = NEW.resource_id), 'tenantA');
  ELSIF NEW.resource_type = 'router' THEN
    NEW.tenant_id := COALESCE(
      (SELECT tenant_id FROM traffic_router WHERE id = NEW.resource_id),
      'tenantA');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_event_tenant_from_actor" ON "audit_event";
--> statement-breakpoint
CREATE TRIGGER "audit_event_tenant_from_actor" BEFORE INSERT ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION "set_audit_event_tenant"();
--> statement-breakpoint
DROP INDEX IF EXISTS "model_configuration_revision_number_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_configuration_revision_tenant_number_idx" ON "model_configuration_revision" ("tenant_id", "revision");

--> statement-breakpoint
ALTER TABLE "guardrail_package" ADD COLUMN IF NOT EXISTS "tenant_id" text DEFAULT 'tenantA' NOT NULL REFERENCES "tenant"("id");
--> statement-breakpoint
ALTER TABLE "policy_imported_version" ADD COLUMN IF NOT EXISTS "tenant_id" text DEFAULT 'tenantA' NOT NULL REFERENCES "tenant"("id");
--> statement-breakpoint
DROP INDEX IF EXISTS "model_definition_provider_model_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_definition_tenant_provider_model_idx" ON "model_definition" ("tenant_id", "provider_id", "model", "profile");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_definition_platform_provider_model_idx" ON "model_definition" ("provider_id", "model", "profile") WHERE "tenant_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "model_usage_cost" ADD COLUMN IF NOT EXISTS "tenant_id" text DEFAULT 'tenantA' NOT NULL REFERENCES "tenant"("id");
