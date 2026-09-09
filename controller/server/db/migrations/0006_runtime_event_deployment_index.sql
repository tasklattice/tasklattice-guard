CREATE INDEX "runtime_event_deployment_time_idx" ON "runtime_event" USING btree ("deployment_id","occurred_at","id");
--> statement-breakpoint
CREATE INDEX "runtime_event_time_id_idx" ON "runtime_event" USING btree ("occurred_at","id");
--> statement-breakpoint
CREATE INDEX "runtime_event_request_time_idx" ON "runtime_event" USING btree ("request_id","occurred_at","id");
