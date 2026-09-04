CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guardrail_artifact" (
	"id" text PRIMARY KEY NOT NULL,
	"guardrail_id" text NOT NULL,
	"guardrail_version" text NOT NULL,
	"generation" bigint NOT NULL,
	"compiler_version" text NOT NULL,
	"nemo_version" text NOT NULL,
	"runtime_profile" text NOT NULL,
	"plan" jsonb NOT NULL,
	"config_yaml" text NOT NULL,
	"colang_content" text DEFAULT '' NOT NULL,
	"prompts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action_bindings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dependency_manifest" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checksum" text NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "controller_state" (
	"id" text PRIMARY KEY NOT NULL,
	"desired_generation" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guardrail_deployment" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"guardrail_id" text NOT NULL,
	"integration_id" text,
	"pool_id" text NOT NULL,
	"guardrail_version" text,
	"route_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"traffic_scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	"delete_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guardrail_version" (
	"guardrail_id" text NOT NULL,
	"version" text NOT NULL,
	"generation" bigint NOT NULL,
	"source_draft_revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'compiling' NOT NULL,
	"runtime_profile" text NOT NULL,
	"plan" jsonb NOT NULL,
	"artifact_id" text,
	"failure_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guardrail_version_guardrail_id_version_pk" PRIMARY KEY("guardrail_id","version")
);
--> statement-breakpoint
CREATE TABLE "guardrail" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"draft_config" jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"excluded_test_case_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"logging_level" text DEFAULT 'info' NOT NULL,
	"runtime_profile" text DEFAULT 'auto' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"desired_generation" bigint DEFAULT 0 NOT NULL,
	"active_version" text,
	"active_artifact_id" text,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	"delete_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"adapter" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"verification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	"delete_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_configuration_revision" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"generation" bigint,
	"assignments" jsonb NOT NULL,
	"validation_report" jsonb,
	"failure_reason" text,
	"validated_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_definition" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"name" text NOT NULL,
	"model" text NOT NULL,
	"profile" text DEFAULT 'generic-chat' NOT NULL,
	"timeout_seconds" integer DEFAULT 20 NOT NULL,
	"max_tokens" integer DEFAULT 512 NOT NULL,
	"connection_status" text DEFAULT 'pending' NOT NULL,
	"connection_message" text DEFAULT 'Not checked.' NOT NULL,
	"connection_latency_ms" integer,
	"connection_checked_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"validation_message" text DEFAULT 'Not validated.' NOT NULL,
	"validation_latency_ms" integer,
	"validated_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"base_url" text NOT NULL,
	"skip_tls_verify" boolean DEFAULT false NOT NULL,
	"credential_ciphertext" text NOT NULL,
	"credential_hint" text DEFAULT 'Not required' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"validation_message" text DEFAULT 'Not validated.' NOT NULL,
	"validation_latency_ms" integer,
	"validated_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "controller_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_record" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'custom' NOT NULL,
	"owner" text NOT NULL,
	"draft" jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_validation_run" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text NOT NULL,
	"draft_revision" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "policy_version" (
	"policy_id" text NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"checksum" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_version_policy_id_version_pk" PRIMARY KEY("policy_id","version")
);
--> statement-breakpoint
CREATE TABLE "runner_instance" (
	"runner_id" text PRIMARY KEY NOT NULL,
	"boot_id" text NOT NULL,
	"pool_id" text NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"runner_version" text NOT NULL,
	"nemo_version" text NOT NULL,
	"compiler_capable" boolean DEFAULT false NOT NULL,
	"max_concurrency" integer NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"desired_generation" bigint DEFAULT 0 NOT NULL,
	"applied_generation" bigint DEFAULT 0 NOT NULL,
	"heartbeat_sequence" bigint DEFAULT 0 NOT NULL,
	"load" jsonb,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_pool" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"desired_replicas" integer DEFAULT 1 NOT NULL,
	"safe_rps_per_runner" double precision DEFAULT 1 NOT NULL,
	"max_concurrency_per_runner" integer DEFAULT 64 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_event" (
	"id" text PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" text NOT NULL,
	"runner_id" text NOT NULL,
	"guardrail_id" text,
	"guardrail_version" text,
	"integration_id" text,
	"deployment_id" text,
	"direction" text NOT NULL,
	"decision" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"impersonated_by" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "telemetry_watermark" (
	"runner_id" text PRIMARY KEY NOT NULL,
	"last_event_occurred_at" timestamp with time zone,
	"last_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'user' NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"preferred_language" text DEFAULT 'en' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "guardrail_validation_run" (
	"id" text PRIMARY KEY NOT NULL,
	"guardrail_id" text NOT NULL,
	"guardrail_version" text NOT NULL,
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
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_artifact" ADD CONSTRAINT "guardrail_artifact_guardrail_id_guardrail_id_fk" FOREIGN KEY ("guardrail_id") REFERENCES "public"."guardrail"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_id_auth_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_deployment" ADD CONSTRAINT "guardrail_deployment_guardrail_id_guardrail_id_fk" FOREIGN KEY ("guardrail_id") REFERENCES "public"."guardrail"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_deployment" ADD CONSTRAINT "guardrail_deployment_integration_id_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_deployment" ADD CONSTRAINT "guardrail_deployment_pool_id_runner_pool_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."runner_pool"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_deployment" ADD CONSTRAINT "guardrail_deployment_deleted_by_auth_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_version" ADD CONSTRAINT "guardrail_version_guardrail_id_guardrail_id_fk" FOREIGN KEY ("guardrail_id") REFERENCES "public"."guardrail"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_version" ADD CONSTRAINT "guardrail_version_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail" ADD CONSTRAINT "guardrail_deleted_by_auth_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration" ADD CONSTRAINT "integration_deleted_by_auth_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_configuration_revision" ADD CONSTRAINT "model_configuration_revision_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_definition" ADD CONSTRAINT "model_definition_provider_id_model_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_provider"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_definition" ADD CONSTRAINT "model_definition_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_validation_run" ADD CONSTRAINT "policy_validation_run_policy_id_policy_record_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policy_record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_validation_run" ADD CONSTRAINT "policy_validation_run_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_version" ADD CONSTRAINT "policy_version_policy_id_policy_record_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policy_record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_instance" ADD CONSTRAINT "runner_instance_pool_id_runner_pool_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."runner_pool"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_test_case" ADD CONSTRAINT "guardrail_test_case_guardrail_id_guardrail_id_fk" FOREIGN KEY ("guardrail_id") REFERENCES "public"."guardrail"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_validation_run" ADD CONSTRAINT "guardrail_validation_run_guardrail_id_guardrail_id_fk" FOREIGN KEY ("guardrail_id") REFERENCES "public"."guardrail"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_validation_run" ADD CONSTRAINT "guardrail_validation_run_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_account_user_idx" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_account_issuer_idx" ON "auth_account" USING btree ("issuer","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guardrail_artifact_checksum_idx" ON "guardrail_artifact" USING btree ("checksum");--> statement-breakpoint
CREATE INDEX "guardrail_artifact_version_idx" ON "guardrail_artifact" USING btree ("guardrail_id","guardrail_version");--> statement-breakpoint
CREATE INDEX "audit_resource_idx" ON "audit_event" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "deployment_guardrail_idx" ON "guardrail_deployment" USING btree ("guardrail_id");--> statement-breakpoint
CREATE INDEX "deployment_integration_idx" ON "guardrail_deployment" USING btree ("integration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_integration_route_order_idx" ON "guardrail_deployment" USING btree ("integration_id","route_order") WHERE "guardrail_deployment"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "deployment_pool_idx" ON "guardrail_deployment" USING btree ("pool_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guardrail_version_generation_idx" ON "guardrail_version" USING btree ("generation");--> statement-breakpoint
CREATE INDEX "guardrail_status_idx" ON "guardrail" USING btree ("status");--> statement-breakpoint
CREATE INDEX "integration_status_idx" ON "integration" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "model_configuration_revision_number_idx" ON "model_configuration_revision" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "model_configuration_revision_state_idx" ON "model_configuration_revision" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "model_definition_provider_model_idx" ON "model_definition" USING btree ("provider_id","model","profile");--> statement-breakpoint
CREATE INDEX "model_definition_provider_idx" ON "model_definition" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "model_definition_status_idx" ON "model_definition" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "model_provider_name_idx" ON "model_provider" USING btree ("name");--> statement-breakpoint
CREATE INDEX "model_provider_status_idx" ON "model_provider" USING btree ("status");--> statement-breakpoint
CREATE INDEX "controller_outbox_pending_idx" ON "controller_outbox" USING btree ("processed_at","available_at");--> statement-breakpoint
CREATE INDEX "policy_record_name_idx" ON "policy_record" USING btree ("name");--> statement-breakpoint
CREATE INDEX "policy_validation_run_policy_idx" ON "policy_validation_run" USING btree ("policy_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_version_checksum_idx" ON "policy_version" USING btree ("checksum");--> statement-breakpoint
CREATE INDEX "runner_instance_pool_idx" ON "runner_instance" USING btree ("pool_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_pool_single_default_idx" ON "runner_pool" USING btree ("is_default") WHERE "runner_pool"."is_default" = true;--> statement-breakpoint
CREATE INDEX "runtime_event_guardrail_time_idx" ON "runtime_event" USING btree ("guardrail_id","occurred_at");--> statement-breakpoint
CREATE INDEX "runtime_event_integration_time_idx" ON "runtime_event" USING btree ("integration_id","occurred_at");--> statement-breakpoint
CREATE INDEX "auth_session_user_idx" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "guardrail_test_case_guardrail_idx" ON "guardrail_test_case" USING btree ("guardrail_id");--> statement-breakpoint
CREATE INDEX "guardrail_validation_run_guardrail_idx" ON "guardrail_validation_run" USING btree ("guardrail_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier");