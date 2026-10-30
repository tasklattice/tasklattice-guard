ALTER TABLE guardrail_validation_run ADD COLUMN results_storage text NOT NULL DEFAULT 'legacy';
ALTER TABLE guardrail_validation_run ADD COLUMN snapshot_digest text;
CREATE TABLE guardrail_validation_snapshot (digest text PRIMARY KEY, payload jsonb NOT NULL);
ALTER TABLE guardrail_validation_run ADD CONSTRAINT guardrail_validation_snapshot_ref FOREIGN KEY (snapshot_digest) REFERENCES guardrail_validation_snapshot(digest);
--> statement-breakpoint
CREATE TABLE guardrail_validation_case (
  run_id text NOT NULL REFERENCES guardrail_validation_run(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  case_id text NOT NULL,
  status text NOT NULL,
  priority integer NOT NULL,
  summary jsonb NOT NULL,
  detail jsonb NOT NULL,
  detail_bytes integer NOT NULL,
  PRIMARY KEY (run_id, ordinal),
  CONSTRAINT guardrail_validation_case_identity_idx UNIQUE (run_id, case_id)
);
--> statement-breakpoint
CREATE INDEX guardrail_validation_case_page_idx ON guardrail_validation_case(run_id, priority, ordinal);
CREATE INDEX guardrail_validation_case_status_idx ON guardrail_validation_case(run_id, status, priority, ordinal);
--> statement-breakpoint
CREATE TABLE guardrail_validation_upload (
  run_id text PRIMARY KEY REFERENCES guardrail_validation_run(id) ON DELETE CASCADE,
  upload_id text NOT NULL,
  manifest_digest text NOT NULL,
  chunks integer NOT NULL CHECK (chunks > 0 AND chunks <= 10000),
  cases integer NOT NULL CHECK (cases >= 0 AND cases <= 100000),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE guardrail_validation_chunk (
  run_id text NOT NULL REFERENCES guardrail_validation_upload(run_id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  digest text NOT NULL,
  raw_bytes integer NOT NULL,
  case_offset integer NOT NULL,
  case_count integer NOT NULL,
  PRIMARY KEY (run_id, sequence)
);
