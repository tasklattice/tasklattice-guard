-- Endpoints reach Guardrails only through their bound traffic_router revision.
-- The per-Endpoint guardrail_router table (formerly guardrail_deployment) no
-- longer participates in desired state, readiness, or topology.
DROP TABLE IF EXISTS "guardrail_router";
