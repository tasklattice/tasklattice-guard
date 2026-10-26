ALTER TABLE guardrail_version ADD COLUMN publication jsonb;
--> statement-breakpoint
UPDATE guardrail_version SET publication = jsonb_build_object(
  'source', 'legacy', 'actorId', released_by,
  'createdAt', coalesce(released_at, created_at),
  'legacy', jsonb_build_object('platformRelease', platform_release,
    'testWaiver', test_waiver, 'validationRunId', validation_run_id,
    'sourceValidationRunId', source_validation_run_id))
WHERE status = 'ready';
--> statement-breakpoint
CREATE TABLE deployment_preset (
  key text PRIMARY KEY,
  guardrail_id text NOT NULL,
  profile_id text NOT NULL,
  profile_version text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Existing identity, including a deleted one, means provisioning already ran.
INSERT INTO deployment_preset (key, guardrail_id, profile_id, profile_version)
SELECT 'initial-guardrail', id, 'local-baseline', '1.0.0'
FROM guardrail WHERE id = 'guardrail-default'
ON CONFLICT DO NOTHING;

--> statement-breakpoint
ALTER TABLE guardrail ADD COLUMN creation_key text UNIQUE, ADD COLUMN creation_digest text;
