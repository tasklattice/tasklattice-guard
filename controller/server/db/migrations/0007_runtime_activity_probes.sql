CREATE INDEX "runtime_event_integration_direction_time_idx" ON "runtime_event" ("integration_id", "direction", "occurred_at");
--> statement-breakpoint
CREATE INDEX "runtime_event_integration_error_time_idx" ON "runtime_event" ("integration_id", "occurred_at") WHERE lower(decision) IN ('error','failed','failure','timeout','timed_out');
--> statement-breakpoint
CREATE INDEX "runtime_event_integration_final_time_idx" ON "runtime_event" ("integration_id", "occurred_at") WHERE metadata->>'streamFinalCheck'='true';
