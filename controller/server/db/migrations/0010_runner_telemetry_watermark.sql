ALTER TABLE "runner_instance" ADD COLUMN "telemetry_drained_at" timestamp with time zone;
--> statement-breakpoint
DROP TABLE "telemetry_watermark";
