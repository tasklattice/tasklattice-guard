-- A version is pending until released in this environment, then ready.
-- Releasing binds the passed test run of exactly that content and suite.
-- Compilation is synchronous with publishing, so compiling/failed are gone.
DELETE FROM guardrail_version WHERE status NOT IN ('pending', 'ready');
--> statement-breakpoint
ALTER TABLE guardrail_version DROP COLUMN failure_reason,
  ADD COLUMN released_at timestamptz,
  ADD COLUMN released_by text REFERENCES auth_user(id),
  ALTER COLUMN status DROP DEFAULT;
--> statement-breakpoint
UPDATE guardrail_version SET released_at = created_at, released_by = created_by WHERE origin = 'local';
--> statement-breakpoint
-- Imported versions were never tested in this environment; they wait to be released.
UPDATE guardrail_version SET status = 'pending', validation_run_id = NULL WHERE origin = 'imported';
--> statement-breakpoint
ALTER TABLE guardrail_version ADD CONSTRAINT guardrail_version_release_ck CHECK (
  (status = 'pending' AND released_at IS NULL) OR (status = 'ready' AND released_at IS NOT NULL)
);
