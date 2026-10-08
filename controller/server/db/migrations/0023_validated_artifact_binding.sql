-- Publication reuses the exact Artifact a passed test run compiled and executed.
ALTER TABLE guardrail_validation_run
  ADD COLUMN candidate_artifact jsonb,
  ADD COLUMN candidate_digest text,
  ADD COLUMN candidate_inspection jsonb,
  ADD COLUMN test_suite_digest text,
  ADD COLUMN runtime_fingerprint jsonb;
--> statement-breakpoint
ALTER TABLE guardrail_version
  ADD COLUMN validation_run_id text,
  ADD COLUMN inspection jsonb,
  ALTER COLUMN status SET DEFAULT 'ready';
--> statement-breakpoint
-- The asynchronous compile path is retired; nothing will complete these.
UPDATE guardrail_version SET status = 'failed', failure_reason = 'Publication changed to reuse the tested Artifact. Run tests and publish again.'
  WHERE status = 'compiling';
--> statement-breakpoint
UPDATE controller_outbox SET processed_at = now() WHERE kind = 'guardrail.compile_requested' AND processed_at IS NULL;
