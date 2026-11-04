ALTER TABLE "model_definition" ADD COLUMN "rate_limit_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_definition" ADD COLUMN "lower_threshold" double precision DEFAULT 0.1 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_definition" ADD COLUMN "upper_threshold" double precision DEFAULT 0.9 NOT NULL;