DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "guardrail_version")
    OR EXISTS (SELECT 1 FROM "guardrail_artifact")
    OR EXISTS (SELECT 1 FROM "guardrail_validation_run")
    OR EXISTS (SELECT 1 FROM "guardrail_deployment" WHERE "guardrail_version" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "runtime_event" WHERE "guardrail_version" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "guardrail" WHERE "active_version" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Timestamp Guardrail Versions require a clean versioned-data migration. Remove legacy numeric Guardrail version records before applying this migration.';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "guardrail_artifact" ALTER COLUMN "guardrail_version" SET DATA TYPE text USING "guardrail_version"::text;--> statement-breakpoint
ALTER TABLE "guardrail_deployment" ALTER COLUMN "guardrail_version" SET DATA TYPE text USING "guardrail_version"::text;--> statement-breakpoint
ALTER TABLE "guardrail_version" ALTER COLUMN "version" SET DATA TYPE text USING "version"::text;--> statement-breakpoint
ALTER TABLE "guardrail" ALTER COLUMN "active_version" SET DATA TYPE text USING "active_version"::text;--> statement-breakpoint
ALTER TABLE "runtime_event" ALTER COLUMN "guardrail_version" SET DATA TYPE text USING "guardrail_version"::text;--> statement-breakpoint
ALTER TABLE "guardrail_validation_run" ALTER COLUMN "guardrail_version" SET DATA TYPE text USING "guardrail_version"::text;--> statement-breakpoint
ALTER TABLE "guardrail_validation_run" ALTER COLUMN "guardrail_version" SET NOT NULL;
