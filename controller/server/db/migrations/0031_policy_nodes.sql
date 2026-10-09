-- A release package is a resource tree: Guardrail versions reference Policy
-- versions. Each version keeps the Policy versions it was built from (before
-- any per-binding expansion), so export carries them as nodes and import
-- builds them first. No earlier version is kept: export requires these nodes.
ALTER TABLE guardrail_validation_run ADD COLUMN candidate_policies jsonb;
--> statement-breakpoint
ALTER TABLE guardrail_version ADD COLUMN policies jsonb;
--> statement-breakpoint
-- Custom Policies imported with a Guardrail belong to their source: read only here.
ALTER TABLE policy_record
  ADD COLUMN origin text NOT NULL DEFAULT 'local',
  ADD COLUMN source_id text,
  ADD CONSTRAINT policy_record_origin_ck CHECK ((origin = 'local' AND source_id IS NULL) OR (origin = 'imported' AND source_id IS NOT NULL));
--> statement-breakpoint
-- Built-in Policy versions a package brought that this installation's
-- catalog does not ship: read-only history of that built-in Policy.
CREATE TABLE policy_imported_version (
  policy_id text NOT NULL,
  version text NOT NULL,
  digest text NOT NULL,
  definition jsonb NOT NULL,
  source_id text NOT NULL,
  package_id text REFERENCES guardrail_package(id) ON DELETE SET NULL,
  imported_by text REFERENCES auth_user(id),
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (policy_id, version)
);
