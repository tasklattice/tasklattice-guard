ALTER TABLE "model_definition" ADD COLUMN "connection_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_definition" ADD COLUMN "connection_message" text DEFAULT 'Not checked.' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_definition" ADD COLUMN "connection_latency_ms" integer;--> statement-breakpoint
ALTER TABLE "model_definition" ADD COLUMN "connection_checked_at" timestamp with time zone;