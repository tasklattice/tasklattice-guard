CREATE TABLE "endpoint_telemetry_context_gc_cursor" (
	"id" text PRIMARY KEY NOT NULL,
	"last_retired_at" timestamp with time zone,
	"last_context_id" text,
	CONSTRAINT "endpoint_telemetry_context_gc_cursor_singleton" CHECK ("endpoint_telemetry_context_gc_cursor"."id" = 'singleton'),
	CONSTRAINT "endpoint_telemetry_context_gc_cursor_position" CHECK (("endpoint_telemetry_context_gc_cursor"."last_retired_at" is null) = ("endpoint_telemetry_context_gc_cursor"."last_context_id" is null))
);
