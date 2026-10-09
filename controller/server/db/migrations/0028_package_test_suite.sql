-- Release packages carry each version's frozen test suite, not the source
-- environment's test report: reports are per run and per environment.
ALTER TABLE guardrail_version_provenance DROP COLUMN uat_evidence;
