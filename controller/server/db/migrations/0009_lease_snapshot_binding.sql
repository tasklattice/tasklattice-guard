-- Older experimental ledger entries have no snapshot evidence. They remain
-- NULL and cannot be used by the snapshot-bound grant path.
ALTER TABLE "runner_serving_grant" ADD COLUMN IF NOT EXISTS "snapshot_nonce" text;
--> statement-breakpoint
ALTER TABLE "runner_serving_grant" ADD COLUMN IF NOT EXISTS "model_revision_id" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'runner_serving_grant'::regclass AND conname = 'runner_serving_grant_snapshot_pair') THEN
    ALTER TABLE "runner_serving_grant" ADD CONSTRAINT "runner_serving_grant_snapshot_pair"
      CHECK (("snapshot_nonce" IS NULL AND "model_revision_id" IS NULL) OR
             ("snapshot_nonce" IS NOT NULL AND length("snapshot_nonce") > 0 AND "model_revision_id" IS NOT NULL));
  END IF;
END $$;
