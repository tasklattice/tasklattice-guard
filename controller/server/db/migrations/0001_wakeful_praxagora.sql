CREATE TABLE "guardrail_test_case" (
	"id" text NOT NULL,
	"guardrail_id" text NOT NULL,
	"name" text NOT NULL,
	"policy_id" text NOT NULL,
	"phase" text NOT NULL,
	"content" text NOT NULL,
	"expected_decision" text NOT NULL,
	"origin" text DEFAULT 'generated' NOT NULL,
	"trusted_instruction" text DEFAULT '' NOT NULL,
	"target_source" text DEFAULT 'user_input' NOT NULL,
	"query" text DEFAULT '' NOT NULL,
	"grounding_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_reasoning_result" text,
	"case_type" text DEFAULT 'scenario' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"expected_failure" text,
	"concurrency_group" text,
	"source_policy_id" text,
	"source_policy_version" text,
	"source_case_id" text,
	"covered_rule_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guardrail_test_case_guardrail_id_id_pk" PRIMARY KEY("guardrail_id","id")
);
--> statement-breakpoint
CREATE TABLE "guardrail_validation_run" (
	"id" text PRIMARY KEY NOT NULL,
	"guardrail_id" text NOT NULL,
	"guardrail_version" integer,
	"source_draft_revision" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"metrics" jsonb DEFAULT '{"total":0,"passed":0,"complianceRate":0,"falsePositiveRate":0,"falseNegativeRate":0,"escalationRate":0,"p95LatencyMs":0}'::jsonb NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excluded_case_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "guardrail_deployment" ADD COLUMN "guardrail_version" integer;--> statement-breakpoint
ALTER TABLE "guardrail_deployment" ADD COLUMN "route_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "guardrail_deployment" AS deployment
SET "guardrail_version" = guardrail."active_version"
FROM "guardrail" AS guardrail
WHERE guardrail."id" = deployment."guardrail_id";--> statement-breakpoint
WITH ranked AS (
	SELECT "id", row_number() OVER (PARTITION BY "integration_id" ORDER BY "created_at", "id") - 1 AS "position"
	FROM "guardrail_deployment"
)
UPDATE "guardrail_deployment" AS deployment
SET "route_order" = ranked."position"
FROM ranked
WHERE ranked."id" = deployment."id";--> statement-breakpoint
ALTER TABLE "guardrail_version" ADD COLUMN "source_draft_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "guardrail" ADD COLUMN "draft_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "guardrail" ADD COLUMN "excluded_test_case_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "guardrail" ADD COLUMN "logging_level" text DEFAULT 'info' NOT NULL;--> statement-breakpoint
ALTER TABLE "guardrail_test_case" ADD CONSTRAINT "guardrail_test_case_guardrail_id_guardrail_id_fk" FOREIGN KEY ("guardrail_id") REFERENCES "public"."guardrail"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_validation_run" ADD CONSTRAINT "guardrail_validation_run_guardrail_id_guardrail_id_fk" FOREIGN KEY ("guardrail_id") REFERENCES "public"."guardrail"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_validation_run" ADD CONSTRAINT "guardrail_validation_run_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guardrail_test_case_guardrail_idx" ON "guardrail_test_case" USING btree ("guardrail_id");--> statement-breakpoint
CREATE INDEX "guardrail_validation_run_guardrail_idx" ON "guardrail_validation_run" USING btree ("guardrail_id","created_at");
