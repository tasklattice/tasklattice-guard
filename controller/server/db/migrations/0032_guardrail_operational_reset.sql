ALTER TABLE "guardrail" ADD COLUMN "operational_reset_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "route_assignment_guardrail_idx" ON "route_assignment" ("guardrail_id");
