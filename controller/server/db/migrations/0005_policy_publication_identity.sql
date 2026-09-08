-- Existing versions retain NULL: their source revision must not be guessed.
ALTER TABLE "policy_version" ADD COLUMN "source_draft_revision" integer;
--> statement-breakpoint
CREATE UNIQUE INDEX "policy_version_source_draft_idx" ON "policy_version" ("policy_id", "source_draft_revision");
