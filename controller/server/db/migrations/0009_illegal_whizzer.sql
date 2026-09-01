UPDATE "runner_instance" SET "status" = 'offline' WHERE "status" = 'registered';--> statement-breakpoint
ALTER TABLE "runner_instance" ALTER COLUMN "status" SET DEFAULT 'offline';
