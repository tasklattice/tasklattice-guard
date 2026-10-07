-- Router publication is a reviewed change: a submitter freezes the exact
-- snapshot and a different administrator approves it, which applies it.
CREATE TABLE traffic_router_change_request (
 id text PRIMARY KEY, router_id text NOT NULL REFERENCES traffic_router(id),
 kind text NOT NULL, status text NOT NULL,
 source_draft_revision integer, base_revision integer,
 snapshot jsonb NOT NULL, endpoint_ids jsonb NOT NULL, context jsonb,
 ticket text NOT NULL DEFAULT '', reason text NOT NULL,
 submitted_by text NOT NULL REFERENCES "auth_user"(id), submitted_at timestamptz NOT NULL DEFAULT now(),
 decided_by text REFERENCES "auth_user"(id), decided_at timestamptz, decision_note text,
 emergency_reason text, emergency_contact text,
 applied_revision integer, reverts_change_request_id text REFERENCES traffic_router_change_request(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX traffic_router_change_request_pending_idx ON traffic_router_change_request(router_id) WHERE status = 'pending';
CREATE INDEX traffic_router_change_request_router_idx ON traffic_router_change_request(router_id, submitted_at);
ALTER TABLE traffic_router_revision ADD COLUMN change_request_id text REFERENCES traffic_router_change_request(id);
