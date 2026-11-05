ALTER TABLE "public"."deployment_preset" RENAME TO "default_guardrail_provisioning";
ALTER TABLE "public"."default_guardrail_provisioning" RENAME COLUMN "key" TO "scope_key";
ALTER TABLE "public"."default_guardrail_provisioning" RENAME CONSTRAINT "deployment_preset_pkey" TO "default_guardrail_provisioning_pkey";
UPDATE "public"."default_guardrail_provisioning"
SET "scope_key" = CASE
  WHEN "scope_key" = 'initial-guardrail' THEN 'platform'
  WHEN "scope_key" LIKE 'project-default:%' THEN 'project:' || substr("scope_key", length('project-default:') + 1)
  ELSE "scope_key"
END;
