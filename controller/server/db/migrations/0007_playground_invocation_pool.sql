-- Historical invocation mappings may have no recorded pool. Do not infer one
-- from today's membership: pools and tenants can move between groups.
ALTER TABLE "playground_invocation" ADD COLUMN IF NOT EXISTS "pool_id" text;
--> statement-breakpoint
ALTER TABLE "playground_invocation" ADD COLUMN IF NOT EXISTS "group_id" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'playground_invocation'::regclass AND conname = 'playground_invocation_allocation_pair') THEN
    ALTER TABLE "playground_invocation" ADD CONSTRAINT "playground_invocation_allocation_pair"
      CHECK (("pool_id" IS NULL AND "group_id" IS NULL) OR
             ("pool_id" IS NOT NULL AND length("pool_id") > 0 AND "group_id" IS NOT NULL AND length("group_id") > 0));
  END IF;
END $$;
