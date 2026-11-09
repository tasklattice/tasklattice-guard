ALTER TABLE "public".policy_resource_validation DROP CONSTRAINT policy_resource_validation_policy_id_fkey;
ALTER TABLE "public".policy_resource_validation ADD COLUMN project_id text REFERENCES "public".project(id);
ALTER TABLE "public".policy_resource_validation ADD COLUMN version text;
ALTER TABLE "public".policy_resource_validation ADD COLUMN snapshot jsonb;
CREATE INDEX policy_version_test_project_idx ON "public".policy_resource_validation(project_id, policy_id, version, created_at DESC);
