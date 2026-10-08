-- Self-contained release packages: imported Guardrails are owned by one
-- trusted source and carry provenance instead of a working draft.
ALTER TABLE guardrail ADD COLUMN origin text NOT NULL DEFAULT 'local', ADD COLUMN source_id text;
--> statement-breakpoint
ALTER TABLE guardrail ADD CONSTRAINT guardrail_origin_ck
  CHECK ((origin = 'local' AND source_id IS NULL) OR (origin = 'imported' AND source_id IS NOT NULL));
--> statement-breakpoint
ALTER TABLE guardrail_version ADD COLUMN origin text NOT NULL DEFAULT 'local', ADD COLUMN environment_check jsonb;
--> statement-breakpoint
CREATE TABLE guardrail_package (
  id text PRIMARY KEY,
  content bytea NOT NULL,
  size_bytes integer NOT NULL,
  source_id text NOT NULL,
  key_id text NOT NULL,
  guardrail_id text NOT NULL,
  manifest jsonb NOT NULL,
  uploaded_by text REFERENCES auth_user(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  last_imported_at timestamptz
);
--> statement-breakpoint
CREATE TABLE guardrail_version_provenance (
  guardrail_id text NOT NULL,
  version text NOT NULL,
  source_id text NOT NULL,
  source_key_id text NOT NULL,
  content_digest text NOT NULL,
  file_digests jsonb NOT NULL,
  requirements jsonb NOT NULL,
  uat_evidence jsonb NOT NULL,
  source_signature jsonb NOT NULL,
  package_id text NOT NULL REFERENCES guardrail_package(id),
  imported_by text REFERENCES auth_user(id),
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guardrail_id, version),
  FOREIGN KEY (guardrail_id, version) REFERENCES guardrail_version(guardrail_id, version) ON DELETE CASCADE
);
