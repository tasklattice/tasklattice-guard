-- A test run targets a draft (compiled into a candidate) or an existing
-- version, whose signed Artifact is tested as it is in this environment.
ALTER TABLE guardrail_validation_run ADD COLUMN subject text NOT NULL DEFAULT 'draft'
  CHECK (subject IN ('draft', 'version'));
