ALTER TABLE guardrail_artifact ADD COLUMN content_digest_version smallint NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE guardrail_artifact ALTER COLUMN content_digest_version SET DEFAULT 2;
