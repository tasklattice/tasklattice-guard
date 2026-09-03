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
ALTER TABLE "model_configuration_revision" ADD CONSTRAINT "model_configuration_revision_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_definition" ADD CONSTRAINT "model_definition_provider_id_model_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_provider"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_definition" ADD CONSTRAINT "model_definition_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_configuration_revision_number_idx" ON "model_configuration_revision" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "model_configuration_revision_state_idx" ON "model_configuration_revision" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "model_definition_provider_model_idx" ON "model_definition" USING btree ("provider_id","model","profile");--> statement-breakpoint
CREATE INDEX "model_definition_provider_idx" ON "model_definition" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "model_definition_status_idx" ON "model_definition" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "model_provider_name_idx" ON "model_provider" USING btree ("name");--> statement-breakpoint
CREATE INDEX "model_provider_status_idx" ON "model_provider" USING btree ("status");