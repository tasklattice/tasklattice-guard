-- Playground Runner telemetry is asynchronous; retain the Controller-minted
-- association rather than accepting a tenant supplied by the Runner.
CREATE TABLE IF NOT EXISTS "playground_invocation" (
  "call_id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenant"("id"),
  "guardrail_id" text NOT NULL,
  "guardrail_version" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "playground_invocation_expiry_idx" ON "playground_invocation" ("expires_at");
--> statement-breakpoint
-- Unknown provenance must be platform-only rather than silently tenantA.
ALTER TABLE "runtime_event" ALTER COLUMN "tenant_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "runtime_event" ALTER COLUMN "tenant_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "model_usage_cost" ALTER COLUMN "tenant_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_usage_cost" ALTER COLUMN "tenant_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "route_assignment" ALTER COLUMN "tenant_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "route_assignment" ALTER COLUMN "tenant_id" DROP DEFAULT;
