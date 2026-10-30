-- Expand first. 0057 is applied only after the bounded data migration commits.
CREATE TABLE validation_report (
  id text PRIMARY KEY,
  guardrail_run_id text UNIQUE REFERENCES guardrail_validation_run(id) ON DELETE CASCADE,
  policy_run_id text UNIQUE REFERENCES policy_validation_run(id) ON DELETE CASCADE,
  policy_job_id text UNIQUE REFERENCES policy_resource_validation(id) ON DELETE CASCADE,
  migration_complete boolean NOT NULL DEFAULT false,
  CHECK (num_nonnulls(guardrail_run_id, policy_run_id, policy_job_id) = 1)
);
INSERT INTO validation_report(id,guardrail_run_id) SELECT id,id FROM guardrail_validation_run;
INSERT INTO validation_report(id,policy_run_id) SELECT id,id FROM policy_validation_run;
INSERT INTO validation_report(id,policy_job_id) SELECT id,id FROM policy_resource_validation;
--> statement-breakpoint
CREATE FUNCTION register_validation_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'guardrail_validation_run' THEN
    INSERT INTO validation_report(id,guardrail_run_id) VALUES(NEW.id,NEW.id);
  ELSIF TG_TABLE_NAME = 'policy_validation_run' THEN
    INSERT INTO validation_report(id,policy_run_id) VALUES(NEW.id,NEW.id);
  ELSE
    INSERT INTO validation_report(id,policy_job_id) VALUES(NEW.id,NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER register_report AFTER INSERT ON guardrail_validation_run FOR EACH ROW EXECUTE FUNCTION register_validation_report();
CREATE TRIGGER register_report AFTER INSERT ON policy_validation_run FOR EACH ROW EXECUTE FUNCTION register_validation_report();
CREATE TRIGGER register_report AFTER INSERT ON policy_resource_validation FOR EACH ROW EXECUTE FUNCTION register_validation_report();
--> statement-breakpoint
CREATE VIEW validation_report_state AS
SELECT id,status FROM guardrail_validation_run UNION ALL
SELECT id,status FROM policy_validation_run UNION ALL
SELECT id,status FROM policy_resource_validation;
ALTER TABLE guardrail_validation_case RENAME TO validation_report_case;
ALTER TABLE validation_report_case DROP CONSTRAINT guardrail_validation_case_run_id_fkey;
ALTER TABLE validation_report_case ADD FOREIGN KEY(run_id) REFERENCES validation_report(id) ON DELETE CASCADE;
ALTER TABLE validation_report_case ALTER COLUMN detail DROP NOT NULL;
ALTER TABLE validation_report_case ADD COLUMN assessment jsonb NOT NULL DEFAULT '{}';
CREATE TABLE validation_report_detail (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES validation_report(id) ON DELETE CASCADE,
  body jsonb NOT NULL,
  bytes integer NOT NULL CHECK(bytes >= 0)
);
CREATE INDEX validation_report_detail_owner_idx ON validation_report_detail(owner_id);
ALTER TABLE validation_report_case ADD COLUMN detail_id text REFERENCES validation_report_detail(id) ON DELETE CASCADE;
CREATE INDEX validation_report_case_detail_idx ON validation_report_case(detail_id);
ALTER TABLE guardrail_validation_upload RENAME TO validation_report_upload;
ALTER TABLE validation_report_upload DROP CONSTRAINT guardrail_validation_upload_run_id_fkey;
ALTER TABLE validation_report_upload ADD FOREIGN KEY(run_id) REFERENCES validation_report(id) ON DELETE CASCADE;
ALTER TABLE guardrail_validation_chunk RENAME TO validation_report_chunk;
ALTER TABLE validation_report_upload ADD COLUMN runner_boot_id text NOT NULL DEFAULT 'migration';
ALTER TABLE validation_report_upload ADD COLUMN retired_boot_ids text[] NOT NULL DEFAULT '{}';
CREATE INDEX guardrail_validation_snapshot_digest_idx ON guardrail_validation_run(snapshot_digest);
