-- Rename product entities without retaining legacy tables or API aliases.
ALTER TABLE "integration" RENAME TO "endpoint";
--> statement-breakpoint
ALTER TABLE "guardrail_deployment" RENAME TO "guardrail_router";
--> statement-breakpoint
ALTER TABLE "guardrail_router" RENAME COLUMN "integration_id" TO "endpoint_id";
--> statement-breakpoint
ALTER TABLE "runtime_event" RENAME COLUMN "integration_id" TO "endpoint_id";
--> statement-breakpoint
ALTER TABLE "runtime_event" RENAME COLUMN "deployment_id" TO "router_id";
--> statement-breakpoint
ALTER TABLE "endpoint" RENAME CONSTRAINT "integration_pkey" TO "endpoint_pkey";
--> statement-breakpoint
ALTER TABLE "endpoint" RENAME CONSTRAINT "integration_deleted_by_auth_user_id_fk" TO "endpoint_deleted_by_auth_user_id_fk";
--> statement-breakpoint
ALTER TABLE "guardrail_router" RENAME CONSTRAINT "guardrail_deployment_pkey" TO "guardrail_router_pkey";
--> statement-breakpoint
ALTER TABLE "guardrail_router" RENAME CONSTRAINT "guardrail_deployment_guardrail_id_guardrail_id_fk" TO "guardrail_router_guardrail_id_guardrail_id_fk";
--> statement-breakpoint
ALTER TABLE "guardrail_router" RENAME CONSTRAINT "guardrail_deployment_integration_id_integration_id_fk" TO "guardrail_router_endpoint_id_endpoint_id_fk";
--> statement-breakpoint
ALTER TABLE "guardrail_router" RENAME CONSTRAINT "guardrail_deployment_pool_id_runner_pool_id_fk" TO "guardrail_router_pool_id_runner_pool_id_fk";
--> statement-breakpoint
ALTER TABLE "guardrail_router" RENAME CONSTRAINT "guardrail_deployment_deleted_by_auth_user_id_fk" TO "guardrail_router_deleted_by_auth_user_id_fk";
--> statement-breakpoint
ALTER INDEX "integration_status_idx" RENAME TO "endpoint_status_idx";
--> statement-breakpoint
ALTER INDEX "deployment_guardrail_idx" RENAME TO "router_guardrail_idx";
--> statement-breakpoint
ALTER INDEX "deployment_integration_idx" RENAME TO "router_endpoint_idx";
--> statement-breakpoint
ALTER INDEX "deployment_integration_route_order_idx" RENAME TO "router_endpoint_route_order_idx";
--> statement-breakpoint
ALTER INDEX "deployment_pool_idx" RENAME TO "router_pool_idx";
--> statement-breakpoint
ALTER INDEX "runtime_event_integration_time_idx" RENAME TO "runtime_event_endpoint_time_idx";
--> statement-breakpoint
ALTER INDEX "runtime_event_deployment_time_idx" RENAME TO "runtime_event_router_time_idx";
--> statement-breakpoint
ALTER INDEX "runtime_event_integration_direction_time_idx" RENAME TO "runtime_event_endpoint_direction_time_idx";
--> statement-breakpoint
ALTER INDEX "runtime_event_integration_error_time_idx" RENAME TO "runtime_event_endpoint_error_time_idx";
--> statement-breakpoint
ALTER INDEX "runtime_event_integration_final_time_idx" RENAME TO "runtime_event_endpoint_final_time_idx";
--> statement-breakpoint
CREATE FUNCTION pg_temp.rename_endpoint_scope(value jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE result jsonb; key text; child jsonb;
BEGIN
  IF jsonb_typeof(value) = 'array' THEN
    SELECT coalesce(jsonb_agg(pg_temp.rename_endpoint_scope(item)), '[]'::jsonb) INTO result FROM jsonb_array_elements(value) AS items(item);
    RETURN result;
  ELSIF jsonb_typeof(value) = 'object' THEN
    result := '{}'::jsonb;
    FOR key, child IN SELECT * FROM jsonb_each(value) LOOP
      IF key = 'field' AND child = '"integration.id"'::jsonb THEN
        child := '"endpoint.id"'::jsonb;
      ELSE
        child := pg_temp.rename_endpoint_scope(child);
      END IF;
      result := result || jsonb_build_object(key, child);
    END LOOP;
    RETURN result;
  END IF;
  RETURN value;
END;
$$;
--> statement-breakpoint
UPDATE "guardrail_router" SET "traffic_scope" = pg_temp.rename_endpoint_scope("traffic_scope");
--> statement-breakpoint
UPDATE "guardrail_router" SET "id" = 'router-default', "name" = 'Default Router' WHERE "id" = 'deployment-default';
--> statement-breakpoint
UPDATE "runtime_event" SET "router_id" = 'router-default' WHERE "router_id" = 'deployment-default';
--> statement-breakpoint
DROP FUNCTION pg_temp.rename_endpoint_scope(jsonb);
