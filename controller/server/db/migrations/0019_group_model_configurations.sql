-- Explicit opt-in; no existing group is assigned a scoped policy by migration.
CREATE TABLE "tenant_group_model_configuration" (
  "group_id" text PRIMARY KEY NOT NULL REFERENCES "tenant_group"("id") ON DELETE CASCADE,
  "id" text NOT NULL UNIQUE,
  "version" bigint NOT NULL CHECK ("version" BETWEEN 1 AND 9007199254740991),
  "mode" text NOT NULL CHECK ("mode" IN ('legacy','scoped','blocked')),
  "source_revision_id" text,
  "source_fingerprint" text,
  "runtime_payload" jsonb,
  "credential_ciphertexts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "snapshot_digest" text,
  "generation" bigint NOT NULL CHECK ("generation" BETWEEN 0 AND 9007199254740991),
  "updated_by" text NOT NULL REFERENCES "auth_user"("id"),
  "updated_at" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CHECK (("mode"='scoped' AND "source_revision_id" IS NOT NULL AND "source_fingerprint" ~ '^[a-f0-9]{64}$'
      AND "runtime_payload" IS NOT NULL AND "snapshot_digest" ~ '^[a-f0-9]{64}$')
    OR ("mode" IN ('legacy','blocked') AND "source_revision_id" IS NULL AND "source_fingerprint" IS NULL
      AND "runtime_payload" IS NULL AND "credential_ciphertexts"='{}'::jsonb AND "snapshot_digest" IS NULL)),
  CHECK (octet_length(coalesce("runtime_payload"::text,'')) + octet_length("credential_ciphertexts"::text) <= 262144)
);
--> statement-breakpoint
CREATE FUNCTION protect_group_model_configuration() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM tenant_group WHERE id=OLD.group_id) THEN
      RAISE EXCEPTION 'Replace group model policy explicitly; deletion cannot restore legacy authority';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.group_id IS DISTINCT FROM OLD.group_id OR NEW.version <> OLD.version + 1 OR NEW.id = OLD.id OR NEW.generation <= OLD.generation THEN
    RAISE EXCEPTION 'Group model policy replacement requires a fresh identity and next version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER group_model_configuration_replacement BEFORE UPDATE OR DELETE ON "tenant_group_model_configuration"
  FOR EACH ROW EXECUTE FUNCTION protect_group_model_configuration();
