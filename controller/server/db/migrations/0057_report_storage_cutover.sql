-- The application migrator completes each report in its own transaction before
-- this contract migration. Refuse to discard any unconverted report.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM validation_report WHERE NOT migration_complete) THEN
    RAISE EXCEPTION 'Report data migration has not completed';
  END IF;
END $$;
ALTER TABLE validation_report_case ALTER COLUMN detail_id SET NOT NULL;
ALTER TABLE validation_report_case DROP COLUMN detail;
ALTER TABLE guardrail_validation_run DROP COLUMN results, DROP COLUMN results_storage,
  DROP COLUMN candidate_artifact, DROP COLUMN candidate_policies,
  DROP COLUMN candidate_inspection, DROP COLUMN test_suite;
ALTER TABLE policy_validation_run DROP COLUMN results;
ALTER TABLE policy_resource_validation DROP COLUMN results;
ALTER TABLE validation_report DROP COLUMN migration_complete;

ALTER TABLE validation_report_upload ALTER COLUMN runner_boot_id DROP DEFAULT;
