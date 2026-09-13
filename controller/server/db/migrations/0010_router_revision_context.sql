-- NULL explicitly means publication context was not captured. Never backfill from live entities.
ALTER TABLE "traffic_router_revision" ADD COLUMN "context" jsonb;
