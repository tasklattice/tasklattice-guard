CREATE TABLE IF NOT EXISTS "tenant_group" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "tenant_group" ("id", "name", "is_default")
  VALUES ('default', 'Default group', true) ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_group_single_default_idx" ON "tenant_group" ("is_default") WHERE "is_default" = true;
--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN IF NOT EXISTS "group_id" text DEFAULT 'default' NOT NULL REFERENCES "tenant_group"("id");
--> statement-breakpoint
ALTER TABLE "runner_pool" ADD COLUMN IF NOT EXISTS "group_id" text DEFAULT 'default' NOT NULL REFERENCES "tenant_group"("id");
--> statement-breakpoint
ALTER TABLE "runner_pool" ADD COLUMN IF NOT EXISTS "runtime_url" text;
--> statement-breakpoint
ALTER TABLE "runner_pool" ADD COLUMN IF NOT EXISTS "public_url" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_group_idx" ON "tenant" ("group_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runner_pool_group_idx" ON "runner_pool" ("group_id");
