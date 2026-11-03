-- Prior audit ownership was inferred from the actor or a tenantA fallback.
-- Keep the evidence, but do not expose it as tenant-owned without provenance.
ALTER TABLE "audit_event" ALTER COLUMN "tenant_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_event" ALTER COLUMN "tenant_id" DROP DEFAULT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "historical_audit_attribution" (
  "audit_id" text PRIMARY KEY NOT NULL,
  "previous_tenant_id" text NOT NULL,
  "quarantined_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "historical_audit_quarantine_checkpoint" (
  "id" text PRIMARY KEY NOT NULL,
  "completed_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Stop old Controller writers during upgrade and keep them stopped: otherwise
-- they can recreate unsafe assignments after this checkpoint.
DO $$
BEGIN
  LOCK TABLE "historical_audit_quarantine_checkpoint" IN EXCLUSIVE MODE;
  IF NOT EXISTS (SELECT 1 FROM "historical_audit_quarantine_checkpoint" WHERE id = '0054') THEN
    LOCK TABLE "audit_event" IN SHARE ROW EXCLUSIVE MODE;
    INSERT INTO "historical_audit_attribution" ("audit_id", "previous_tenant_id")
      SELECT id, tenant_id FROM "audit_event" WHERE tenant_id IS NOT NULL
      ON CONFLICT DO NOTHING;
    UPDATE "audit_event" SET tenant_id = NULL WHERE tenant_id IS NOT NULL;
    INSERT INTO "historical_audit_quarantine_checkpoint" (id) VALUES ('0054');
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "set_audit_event_tenant"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_id text;
  owner_count integer;
BEGIN
  -- Derive ownership from the resource, not the actor. A platform admin may
  -- act on a resource owned by any tenant. NULL is intentionally platform-only.
  IF NEW.resource_type = 'guardrail' THEN
    SELECT tenant_id INTO owner_id FROM guardrail WHERE id = NEW.resource_id;
  ELSIF NEW.resource_type = 'endpoint' THEN
    SELECT tenant_id INTO owner_id FROM endpoint WHERE id = NEW.resource_id;
  ELSIF NEW.resource_type = 'router' THEN
    SELECT tenant_id INTO owner_id FROM traffic_router WHERE id = NEW.resource_id;
  ELSIF NEW.resource_type = 'policy' THEN
    SELECT COUNT(DISTINCT tenant_id), MIN(tenant_id) INTO owner_count, owner_id FROM (
      SELECT tenant_id FROM policy_resource WHERE id = NEW.resource_id
      UNION ALL SELECT tenant_id FROM policy_record WHERE id = NEW.resource_id
      UNION ALL SELECT tenant_id FROM policy_imported_version WHERE policy_id = NEW.resource_id
    ) AS policy_owners;
    IF owner_count > 1 THEN owner_id := NULL; END IF;
    -- The hard-delete path captures the owner from locked records before
    -- removing them. This value is Controller-produced, not request input.
    IF owner_count = 0 AND NEW.kind = 'policy.deleted' THEN
      owner_id := NEW.tenant_id;
    END IF;
  ELSIF NEW.resource_type IN ('model', 'model_definition') THEN
    SELECT tenant_id INTO owner_id FROM model_definition WHERE id = NEW.resource_id;
  ELSIF NEW.resource_type = 'access_token' THEN
    -- Admin token operations can refer to platform or other-tenant resources.
    SELECT u.tenant_id INTO owner_id FROM personal_access_token t
      JOIN auth_user u ON u.id = t.user_id
      WHERE t.id = NEW.resource_id AND u.id = NEW.actor_id AND u.role = 'user';
  END IF;
  NEW.tenant_id := owner_id;
  RETURN NEW;
END;
$$;
