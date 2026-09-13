CREATE TABLE traffic_router (
 id text PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '',
 draft_revision integer NOT NULL DEFAULT 1, draft jsonb NOT NULL,
 deleted_at timestamptz, rollout_error text,
 active_revision integer, active_draft_revision integer, active_snapshot jsonb,
 desired_generation bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE traffic_router_revision (
 router_id text NOT NULL REFERENCES traffic_router(id), revision integer NOT NULL,
 source_draft_revision integer NOT NULL, request_draft_revision integer NOT NULL, rollback_revision integer, snapshot jsonb NOT NULL, idempotency_key text NOT NULL,
 created_by text NOT NULL REFERENCES "auth_user"(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(router_id, revision), UNIQUE(router_id,idempotency_key)
);
ALTER TABLE endpoint ADD COLUMN traffic_router_id text REFERENCES traffic_router(id);
CREATE INDEX endpoint_traffic_router_idx ON endpoint(traffic_router_id);
ALTER TABLE guardrail ADD COLUMN copy_origin jsonb;
ALTER TABLE guardrail ADD COLUMN duplicate_key text UNIQUE;
ALTER TABLE guardrail_version ADD COLUMN source_snapshot jsonb;
CREATE TABLE route_assignment (
 call_id text NOT NULL, assignment_status text NOT NULL, failure_reason text,
 decision_id text PRIMARY KEY, router_id text NOT NULL, router_revision integer NOT NULL,
 route_id text NOT NULL, target_id text NOT NULL, guardrail_id text NOT NULL, guardrail_version text NOT NULL,
 endpoint_id text NOT NULL, occurred_at timestamptz NOT NULL, completed_at timestamptz,
 completion_inferred boolean NOT NULL DEFAULT false, outcome text, duration_ms integer
);
CREATE INDEX route_assignment_router_time_idx ON route_assignment(router_id,occurred_at);
