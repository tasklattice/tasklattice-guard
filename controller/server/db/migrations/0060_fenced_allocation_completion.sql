-- Completion stays unavailable unless trusted application code injects an
-- authoritative permanent external-fence verifier. No HTTP attestation exists.
ALTER TABLE "tenant_group_move" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
ALTER TABLE "tenant_group_move" ADD COLUMN IF NOT EXISTS "completed_generation" bigint;
ALTER TABLE "tenant_group_move" ADD COLUMN IF NOT EXISTS "completed_actor_id" text REFERENCES "auth_user"("id");
ALTER TABLE "tenant_group_move" ADD COLUMN IF NOT EXISTS "fence_verifier_id" text;
ALTER TABLE "tenant_group_move" ADD COLUMN IF NOT EXISTS "fence_evidence_id" text;
ALTER TABLE "tenant_group_move" ADD COLUMN IF NOT EXISTS "fence_binding_digest" text;
--> statement-breakpoint
ALTER TABLE "tenant_group_move" DROP CONSTRAINT IF EXISTS "tenant_group_move_state_check";
ALTER TABLE "tenant_group_move" ADD CONSTRAINT "tenant_group_move_state_check" CHECK ("state" IN ('prepared', 'completed'));
ALTER TABLE "tenant_group_move" DROP CONSTRAINT IF EXISTS "tenant_group_move_completion_check";
ALTER TABLE "tenant_group_move" ADD CONSTRAINT "tenant_group_move_completion_check" CHECK (
  ("state" = 'prepared' AND "completed_at" IS NULL AND "completed_generation" IS NULL AND "completed_actor_id" IS NULL
    AND "fence_verifier_id" IS NULL AND "fence_evidence_id" IS NULL AND "fence_binding_digest" IS NULL)
  OR ("state" = 'completed' AND "completed_at" IS NOT NULL AND "completed_generation" IS NOT NULL AND "completed_generation" BETWEEN 0 AND 9007199254740991
    AND "completed_actor_id" IS NOT NULL AND "fence_verifier_id" IS NOT NULL AND length("fence_verifier_id") BETWEEN 1 AND 256
    AND "fence_evidence_id" IS NOT NULL AND length("fence_evidence_id") BETWEEN 1 AND 256
    AND "fence_binding_digest" IS NOT NULL AND "fence_binding_digest" ~ '^[0-9a-f]{64}$'
    AND "wait_attempt_id" IS NOT NULL AND "wait_process_id" IS NOT NULL AND "wait_observed_at" IS NOT NULL
    AND "wait_elapsed_ms" IS NOT NULL AND "wait_elapsed_ms" >= "wait_horizon_ms")
);
--> statement-breakpoint
ALTER TABLE "tenant_group_move" DROP CONSTRAINT IF EXISTS "tenant_group_move_subject_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_group_move_subject_idx" ON "tenant_group_move" ("kind", "subject_id") WHERE "state" = 'prepared';
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_group_move_fence_evidence_idx" ON "tenant_group_move" ("fence_verifier_id", "fence_evidence_id") WHERE "state" = 'completed';
--> statement-breakpoint
ALTER TABLE "tenant_group_move_pool" ADD COLUMN IF NOT EXISTS "released_at" timestamp with time zone;
ALTER TABLE "tenant_group_move_pool" DROP CONSTRAINT IF EXISTS "tenant_group_move_pool_pkey";
ALTER TABLE "tenant_group_move_pool" ADD CONSTRAINT "tenant_group_move_pool_pkey" PRIMARY KEY ("move_id", "pool_id");
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_group_move_pool_active_idx" ON "tenant_group_move_pool" ("pool_id") WHERE "released_at" IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_runner_pool_barrier_revision() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM tenant_group_move_pool WHERE pool_id = OLD.pool_id AND released_at IS NULL) THEN
      RAISE EXCEPTION 'a claimed allocation barrier cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.barrier_revision := 0;
    RETURN NEW;
  END IF;
  IF NEW.pool_id IS DISTINCT FROM OLD.pool_id THEN
    RAISE EXCEPTION 'a pool lease identity cannot be changed' USING ERRCODE = '55000';
  END IF;
  IF NEW.epoch IS DISTINCT FROM OLD.epoch OR NEW.draining IS DISTINCT FROM OLD.draining THEN
    NEW.barrier_revision := OLD.barrier_revision + 1;
  ELSIF NEW.barrier_revision IS DISTINCT FROM OLD.barrier_revision THEN
    RAISE EXCEPTION 'allocation barrier revision is maintained by the database' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
