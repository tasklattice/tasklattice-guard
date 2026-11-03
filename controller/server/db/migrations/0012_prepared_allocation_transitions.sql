-- Disabled-by-default preparation groundwork. No API commits membership or
-- clears draining/required external fencing using these records.
CREATE TABLE IF NOT EXISTS "tenant_group_move" (
  "id" text PRIMARY KEY NOT NULL,
  "idempotency_key" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('tenant', 'pool')),
  "subject_id" text NOT NULL,
  "source_group_id" text NOT NULL REFERENCES "tenant_group"("id"),
  "destination_group_id" text NOT NULL REFERENCES "tenant_group"("id"),
  "actor_id" text NOT NULL REFERENCES "auth_user"("id"),
  "state" text NOT NULL DEFAULT 'prepared' CHECK ("state" = 'prepared'),
  "barrier_id" text NOT NULL,
  "timing_policy_id" text NOT NULL,
  "max_grant_duration_ms" integer NOT NULL CHECK ("max_grant_duration_ms" BETWEEN 1 AND 60000),
  "wait_horizon_ms" integer NOT NULL CHECK ("wait_horizon_ms" >= "max_grant_duration_ms" AND "wait_horizon_ms" <= 600000),
  "requires_external_fence" boolean NOT NULL DEFAULT true CHECK ("requires_external_fence"),
  "wait_attempt_id" text,
  "wait_process_id" text,
  "wait_started_at" timestamp with time zone,
  "wait_observed_at" timestamp with time zone,
  "wait_elapsed_ms" bigint CHECK ("wait_elapsed_ms" >= 0),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CHECK ("source_group_id" <> "destination_group_id"),
  CONSTRAINT "tenant_group_move_actor_key_idx" UNIQUE ("actor_id", "idempotency_key"),
  CONSTRAINT "tenant_group_move_subject_idx" UNIQUE ("kind", "subject_id"),
  CONSTRAINT "tenant_group_move_barrier_idx" UNIQUE ("barrier_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_group_move_group" (
  "group_id" text PRIMARY KEY NOT NULL REFERENCES "tenant_group"("id"),
  "move_id" text NOT NULL REFERENCES "tenant_group_move"("id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_group_move_pool" (
  "pool_id" text PRIMARY KEY NOT NULL REFERENCES "runner_pool"("id"),
  "move_id" text NOT NULL REFERENCES "tenant_group_move"("id"),
  "source_group_id" text NOT NULL REFERENCES "tenant_group"("id"),
  "source_epoch" bigint NOT NULL CHECK ("source_epoch" >= 0),
  "source_barrier_revision" bigint NOT NULL CHECK ("source_barrier_revision" BETWEEN 0 AND 9007199254740991),
  "grant_count" bigint NOT NULL CHECK ("grant_count" >= 0),
  "grant_digest" text NOT NULL CHECK ("grant_digest" ~ '^[0-9a-f]{64}$'),
  "longest_grant_ms" integer NOT NULL CHECK ("longest_grant_ms" BETWEEN 0 AND 60000),
  "requires_external_fence" boolean NOT NULL DEFAULT true CHECK ("requires_external_fence")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_group_move_group_move_idx" ON "tenant_group_move_group" ("move_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_group_move_pool_move_idx" ON "tenant_group_move_pool" ("move_id");
--> statement-breakpoint
ALTER TABLE "runner_pool_lease_epoch" ADD COLUMN IF NOT EXISTS "barrier_revision" bigint NOT NULL DEFAULT 0
  CHECK ("barrier_revision" BETWEEN 0 AND 9007199254740991);
--> statement-breakpoint
-- Revision is independent of wall time and survives a drain reset/restoration.
-- Existing writers need not know this column. A privileged database owner can
-- disable triggers; arbitrary owner tampering is outside this service's trust.
CREATE OR REPLACE FUNCTION guard_runner_pool_barrier_revision() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM tenant_group_move_pool WHERE pool_id = OLD.pool_id) THEN
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
--> statement-breakpoint
DROP TRIGGER IF EXISTS runner_pool_barrier_revision ON "runner_pool_lease_epoch";
CREATE TRIGGER runner_pool_barrier_revision BEFORE INSERT OR UPDATE OR DELETE ON "runner_pool_lease_epoch"
  FOR EACH ROW EXECUTE FUNCTION guard_runner_pool_barrier_revision();
