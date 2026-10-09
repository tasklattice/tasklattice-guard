-- A Guardrail version's static definition is its Policies and its Test Cases.
-- A test run freezes the cases it executed; publication copies them onto the
-- version, so the suite travels with the version and can be run again as is.
ALTER TABLE guardrail_validation_run ADD COLUMN test_suite jsonb;
--> statement-breakpoint
ALTER TABLE guardrail_version ADD COLUMN test_suite jsonb;
