-- Current schema after report storage cutover (0057).
-- Built-in Profile definitions are seeded transactionally by the migrator.
CREATE FUNCTION register_validation_report() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_TABLE_NAME = 'guardrail_validation_run' THEN
    INSERT INTO validation_report(id,guardrail_run_id) VALUES(NEW.id,NEW.id);
  ELSIF TG_TABLE_NAME = 'policy_validation_run' THEN
    INSERT INTO validation_report(id,policy_run_id) VALUES(NEW.id,NEW.id);
  ELSE
    INSERT INTO validation_report(id,policy_job_id) VALUES(NEW.id,NEW.id);
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE audit_event (
    id text NOT NULL,
    kind text NOT NULL,
    actor_id text,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE auth_account (
    id text NOT NULL,
    issuer text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE auth_session (
    id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    token text NOT NULL,
    ip_address text,
    user_agent text,
    impersonated_by text,
    user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE auth_user (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    role text DEFAULT 'user'::text NOT NULL,
    banned boolean DEFAULT false NOT NULL,
    ban_reason text,
    ban_expires timestamp with time zone,
    preferred_language text DEFAULT 'en'::text NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    username text
);

CREATE TABLE auth_verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE controller_outbox (
    id text NOT NULL,
    kind text NOT NULL,
    aggregate_id text NOT NULL,
    payload jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE controller_state (
    id text NOT NULL,
    desired_generation bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE deployment_preset (
    key text NOT NULL,
    guardrail_id text NOT NULL,
    profile_id text NOT NULL,
    profile_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE endpoint (
    id text NOT NULL,
    name text NOT NULL,
    adapter text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    verification jsonb DEFAULT '{}'::jsonb NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by text,
    delete_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    traffic_router_id text,
    scan_flag_only_default boolean DEFAULT true NOT NULL
);

CREATE TABLE guardrail (
    id text NOT NULL,
    name text NOT NULL,
    draft_config jsonb NOT NULL,
    draft_revision integer DEFAULT 1 NOT NULL,
    excluded_test_case_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    logging_level text DEFAULT 'info'::text NOT NULL,
    runtime_profile text DEFAULT 'auto'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    desired_generation bigint DEFAULT 0 NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by text,
    delete_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    copy_origin jsonb,
    duplicate_key text,
    origin text DEFAULT 'local'::text NOT NULL,
    source_id text,
    operational_reset_at timestamp with time zone,
    protection_mode text DEFAULT 'enforce'::text NOT NULL,
    protection_mode_applied text DEFAULT 'enforce'::text NOT NULL,
    protection_mode_generation bigint DEFAULT 0 NOT NULL,
    protection_mode_updated_at timestamp with time zone,
    protection_mode_updated_by text,
    protection_mode_reason text DEFAULT ''::text NOT NULL,
    creation_key text,
    creation_digest text,
    CONSTRAINT guardrail_origin_ck CHECK ((((origin = 'local'::text) AND (source_id IS NULL)) OR ((origin = 'imported'::text) AND (source_id IS NOT NULL)))),
    CONSTRAINT guardrail_protection_mode_applied_check CHECK ((protection_mode_applied = ANY (ARRAY['enforce'::text, 'monitor'::text, 'bypass'::text]))),
    CONSTRAINT guardrail_protection_mode_check CHECK ((protection_mode = ANY (ARRAY['enforce'::text, 'monitor'::text, 'bypass'::text])))
);

CREATE TABLE guardrail_artifact (
    id text NOT NULL,
    guardrail_id text NOT NULL,
    guardrail_version text NOT NULL,
    generation bigint NOT NULL,
    compiler_version text NOT NULL,
    nemo_version text NOT NULL,
    runtime_profile text NOT NULL,
    plan jsonb NOT NULL,
    config_yaml text NOT NULL,
    colang_content text DEFAULT ''::text NOT NULL,
    prompts jsonb DEFAULT '[]'::jsonb NOT NULL,
    action_bindings jsonb DEFAULT '[]'::jsonb NOT NULL,
    dependency_manifest jsonb DEFAULT '[]'::jsonb NOT NULL,
    checksum text NOT NULL,
    signature text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    content_digest_version smallint DEFAULT 1 NOT NULL
);

CREATE TABLE guardrail_package (
    id text NOT NULL,
    content bytea NOT NULL,
    size_bytes integer NOT NULL,
    source_id text NOT NULL,
    key_id text,
    guardrail_id text NOT NULL,
    manifest jsonb NOT NULL,
    uploaded_by text,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    last_imported_at timestamp with time zone
);

CREATE TABLE guardrail_profile (
    id text NOT NULL,
    category text NOT NULL,
    category_name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    definition jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE guardrail_test_case (
    id text NOT NULL,
    guardrail_id text NOT NULL,
    name text NOT NULL,
    policy_id text NOT NULL,
    phase text NOT NULL,
    content text NOT NULL,
    expected_decision text NOT NULL,
    origin text DEFAULT 'generated'::text NOT NULL,
    trusted_instruction text DEFAULT ''::text NOT NULL,
    target_source text DEFAULT 'user_input'::text NOT NULL,
    query text DEFAULT ''::text NOT NULL,
    grounding_sources jsonb DEFAULT '[]'::jsonb NOT NULL,
    expected_reasoning_result text,
    case_type text DEFAULT 'scenario'::text NOT NULL,
    required boolean DEFAULT true NOT NULL,
    expected_failure text,
    concurrency_group text,
    source_policy_id text,
    source_policy_version text,
    source_case_id text,
    covered_rule_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE guardrail_validation_run (
    id text NOT NULL,
    guardrail_id text NOT NULL,
    guardrail_version text NOT NULL,
    source_draft_revision integer NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    metrics jsonb DEFAULT '{"total": 0, "passed": 0, "p95LatencyMs": 0, "complianceRate": 0, "escalationRate": 0, "falseNegativeRate": 0, "falsePositiveRate": 0}'::jsonb NOT NULL,
    excluded_case_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    failure_reason text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    progress jsonb,
    candidate_digest text,
    test_suite_digest text,
    runtime_fingerprint jsonb,
    subject text DEFAULT 'draft'::text NOT NULL,
    test_model_rules boolean DEFAULT true NOT NULL,
    test_scope jsonb,
    snapshot_digest text,
    CONSTRAINT guardrail_validation_run_subject_check CHECK ((subject = ANY (ARRAY['draft'::text, 'version'::text])))
);

CREATE TABLE guardrail_validation_snapshot (
    digest text NOT NULL,
    payload jsonb NOT NULL
);

CREATE TABLE guardrail_version (
    guardrail_id text NOT NULL,
    version text NOT NULL,
    generation bigint NOT NULL,
    source_draft_revision integer DEFAULT 1 NOT NULL,
    status text NOT NULL,
    runtime_profile text NOT NULL,
    plan jsonb NOT NULL,
    artifact_id text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_snapshot jsonb,
    validation_run_id text,
    inspection jsonb,
    origin text DEFAULT 'local'::text NOT NULL,
    environment_check jsonb,
    test_suite jsonb,
    released_at timestamp with time zone,
    released_by text,
    policies jsonb,
    testing_evidence jsonb,
    source_validation_run_id text,
    test_waiver jsonb,
    platform_release jsonb,
    publication jsonb,
    CONSTRAINT default_test_waiver_only CHECK (((test_waiver IS NULL) OR ((guardrail_id = 'guardrail-default'::text) AND (source_validation_run_id IS NOT NULL)))),
    CONSTRAINT guardrail_version_release_ck CHECK ((((status = 'pending'::text) AND (released_at IS NULL)) OR ((status = 'ready'::text) AND (released_at IS NOT NULL))))
);

CREATE TABLE guardrail_version_provenance (
    guardrail_id text NOT NULL,
    version text NOT NULL,
    source_id text NOT NULL,
    source_key_id text,
    content_digest text NOT NULL,
    file_digests jsonb NOT NULL,
    requirements jsonb NOT NULL,
    source_signature jsonb,
    package_id text NOT NULL,
    imported_by text,
    imported_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE model_assignment_validation (
    id text NOT NULL,
    actor_id text NOT NULL,
    target text NOT NULL,
    model_id text NOT NULL,
    fingerprint text NOT NULL,
    evidence jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE model_configuration_revision (
    id text NOT NULL,
    revision integer NOT NULL,
    state text DEFAULT 'draft'::text NOT NULL,
    generation bigint,
    assignments jsonb NOT NULL,
    validation_report jsonb,
    failure_reason text,
    validated_at timestamp with time zone,
    activated_at timestamp with time zone,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE model_definition (
    id text NOT NULL,
    provider_id text NOT NULL,
    name text NOT NULL,
    model text NOT NULL,
    profile text DEFAULT 'generic-chat'::text NOT NULL,
    timeout_seconds integer DEFAULT 20 NOT NULL,
    max_tokens integer DEFAULT 512 NOT NULL,
    connection_status text DEFAULT 'pending'::text NOT NULL,
    connection_message text DEFAULT 'Not checked.'::text NOT NULL,
    connection_latency_ms integer,
    connection_checked_at timestamp with time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    validation_message text DEFAULT 'Not validated.'::text NOT NULL,
    validation_latency_ms integer,
    validated_at timestamp with time zone,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE model_price_revision (
    id text NOT NULL,
    key text NOT NULL,
    source text NOT NULL,
    catalog_key text,
    rates jsonb,
    effective_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE model_price_sync (
    id text NOT NULL,
    catalog_version text,
    last_success_at timestamp with time zone,
    error text,
    entries integer DEFAULT 0 NOT NULL,
    metering_since timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE model_provider (
    id text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    base_url text NOT NULL,
    skip_tls_verify boolean DEFAULT false NOT NULL,
    credential_ciphertext text NOT NULL,
    credential_hint text DEFAULT 'Not required'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    validation_message text DEFAULT 'Not validated.'::text NOT NULL,
    validation_latency_ms integer,
    validated_at timestamp with time zone,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE model_usage_cost (
    id text NOT NULL,
    event_id text NOT NULL,
    guardrail_id text NOT NULL,
    guardrail_version text,
    model_id text,
    model text NOT NULL,
    provider text NOT NULL,
    source text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    calls integer DEFAULT 1 NOT NULL,
    input_tokens bigint,
    output_tokens bigint,
    cached_input_tokens bigint,
    price_id text,
    currency text,
    amount numeric(30,12),
    reason text NOT NULL,
    CONSTRAINT model_usage_cost_currency_check CHECK ((currency = 'USD'::text))
);

CREATE TABLE personal_access_token (
    id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    prefix text NOT NULL,
    token_hash text NOT NULL,
    permissions jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone
);

CREATE TABLE policy_imported_version (
    policy_id text NOT NULL,
    version text NOT NULL,
    digest text NOT NULL,
    definition jsonb NOT NULL,
    source_id text NOT NULL,
    package_id text,
    imported_by text,
    imported_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE policy_record (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    source text DEFAULT 'custom'::text NOT NULL,
    owner text NOT NULL,
    draft jsonb NOT NULL,
    draft_revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT 'local'::text NOT NULL,
    source_id text,
    CONSTRAINT policy_record_origin_ck CHECK ((((origin = 'local'::text) AND (source_id IS NULL)) OR ((origin = 'imported'::text) AND (source_id IS NOT NULL))))
);

CREATE TABLE policy_resource (
    id text NOT NULL,
    definition jsonb NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    maintainer text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE policy_resource_validation (
    id text NOT NULL,
    policy_id text NOT NULL,
    parent_id text,
    revision integer NOT NULL,
    status text NOT NULL,
    tests jsonb NOT NULL,
    failure_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE policy_resource_version (
    policy_id text NOT NULL,
    version text NOT NULL,
    revision integer NOT NULL,
    definition jsonb NOT NULL,
    view jsonb NOT NULL,
    digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE policy_validation_run (
    id text NOT NULL,
    policy_id text NOT NULL,
    draft_revision integer NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    failure_reason text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);

CREATE TABLE policy_version (
    policy_id text NOT NULL,
    version integer NOT NULL,
    snapshot jsonb NOT NULL,
    checksum text NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    source_draft_revision integer
);

CREATE TABLE route_assignment (
    call_id text NOT NULL,
    assignment_status text NOT NULL,
    failure_reason text,
    decision_id text NOT NULL,
    router_id text NOT NULL,
    router_revision integer NOT NULL,
    route_id text NOT NULL,
    target_id text NOT NULL,
    guardrail_id text NOT NULL,
    guardrail_version text NOT NULL,
    endpoint_id text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    completion_inferred boolean DEFAULT false NOT NULL,
    outcome text,
    duration_ms integer
);

CREATE TABLE runner_instance (
    runner_id text NOT NULL,
    boot_id text NOT NULL,
    pool_id text NOT NULL,
    status text DEFAULT 'offline'::text NOT NULL,
    runner_version text NOT NULL,
    nemo_version text NOT NULL,
    compiler_capable boolean DEFAULT false NOT NULL,
    max_concurrency integer NOT NULL,
    labels jsonb DEFAULT '{}'::jsonb NOT NULL,
    desired_generation bigint DEFAULT 0 NOT NULL,
    applied_generation bigint DEFAULT 0 NOT NULL,
    heartbeat_sequence bigint DEFAULT 0 NOT NULL,
    load jsonb,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    last_heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    disconnected_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    protection_generation bigint DEFAULT 0 NOT NULL,
    protection_rejected_generation bigint DEFAULT 0 NOT NULL,
    protection_error text
);

CREATE TABLE runner_pool (
    id text NOT NULL,
    name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    desired_replicas integer DEFAULT 1 NOT NULL,
    safe_rps_per_runner double precision DEFAULT 1 NOT NULL,
    max_concurrency_per_runner integer DEFAULT 64 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE runtime_event (
    id text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    request_id text NOT NULL,
    runner_id text NOT NULL,
    guardrail_id text,
    guardrail_version text,
    endpoint_id text,
    router_id text,
    direction text NOT NULL,
    decision text NOT NULL,
    duration_ms integer NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE telemetry_watermark (
    runner_id text NOT NULL,
    last_event_occurred_at timestamp with time zone,
    last_received_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE traffic_router (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    draft_revision integer DEFAULT 1 NOT NULL,
    draft jsonb NOT NULL,
    deleted_at timestamp with time zone,
    rollout_error text,
    active_revision integer,
    active_draft_revision integer,
    active_snapshot jsonb,
    desired_generation bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE traffic_router_change_request (
    id text NOT NULL,
    router_id text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    source_draft_revision integer,
    base_revision integer,
    snapshot jsonb NOT NULL,
    endpoint_ids jsonb NOT NULL,
    context jsonb,
    ticket text DEFAULT ''::text NOT NULL,
    reason text NOT NULL,
    submitted_by text NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_by text,
    decided_at timestamp with time zone,
    decision_note text,
    emergency_reason text,
    emergency_contact text,
    applied_revision integer,
    reverts_change_request_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE traffic_router_revision (
    router_id text NOT NULL,
    revision integer NOT NULL,
    source_draft_revision integer NOT NULL,
    request_draft_revision integer NOT NULL,
    rollback_revision integer,
    snapshot jsonb NOT NULL,
    idempotency_key text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    context jsonb,
    request_digest text,
    generation bigint,
    change_request_id text
);

CREATE TABLE validation_report (
    id text NOT NULL,
    guardrail_run_id text,
    policy_run_id text,
    policy_job_id text,
    CONSTRAINT validation_report_check CHECK ((num_nonnulls(guardrail_run_id, policy_run_id, policy_job_id) = 1))
);

CREATE TABLE validation_report_case (
    run_id text NOT NULL,
    ordinal integer NOT NULL,
    case_id text NOT NULL,
    status text NOT NULL,
    priority integer NOT NULL,
    summary jsonb NOT NULL,
    detail_bytes integer NOT NULL,
    assessment jsonb DEFAULT '{}'::jsonb NOT NULL,
    detail_id text NOT NULL,
    CONSTRAINT guardrail_validation_case_ordinal_check CHECK ((ordinal >= 0))
);

CREATE TABLE validation_report_chunk (
    run_id text NOT NULL,
    sequence integer NOT NULL,
    digest text NOT NULL,
    raw_bytes integer NOT NULL,
    case_offset integer NOT NULL,
    case_count integer NOT NULL
);

CREATE TABLE validation_report_detail (
    id text NOT NULL,
    owner_id text NOT NULL,
    body jsonb NOT NULL,
    bytes integer NOT NULL,
    CONSTRAINT validation_report_detail_bytes_check CHECK ((bytes >= 0))
);

CREATE VIEW validation_report_state AS
 SELECT guardrail_validation_run.id,
    guardrail_validation_run.status
   FROM guardrail_validation_run
UNION ALL
 SELECT policy_validation_run.id,
    policy_validation_run.status
   FROM policy_validation_run
UNION ALL
 SELECT policy_resource_validation.id,
    policy_resource_validation.status
   FROM policy_resource_validation;

CREATE TABLE validation_report_upload (
    run_id text NOT NULL,
    upload_id text NOT NULL,
    manifest_digest text NOT NULL,
    chunks integer NOT NULL,
    cases integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    runner_boot_id text NOT NULL,
    retired_boot_ids text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT guardrail_validation_upload_cases_check CHECK (((cases >= 0) AND (cases <= 100000))),
    CONSTRAINT guardrail_validation_upload_chunks_check CHECK (((chunks > 0) AND (chunks <= 10000)))
);

ALTER TABLE ONLY audit_event
    ADD CONSTRAINT audit_event_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_account
    ADD CONSTRAINT auth_account_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_session
    ADD CONSTRAINT auth_session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_session
    ADD CONSTRAINT auth_session_token_unique UNIQUE (token);

ALTER TABLE ONLY auth_user
    ADD CONSTRAINT auth_user_email_unique UNIQUE (email);

ALTER TABLE ONLY auth_user
    ADD CONSTRAINT auth_user_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_verification
    ADD CONSTRAINT auth_verification_pkey PRIMARY KEY (id);

ALTER TABLE ONLY controller_outbox
    ADD CONSTRAINT controller_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY controller_state
    ADD CONSTRAINT controller_state_pkey PRIMARY KEY (id);

ALTER TABLE ONLY deployment_preset
    ADD CONSTRAINT deployment_preset_pkey PRIMARY KEY (key);

ALTER TABLE ONLY endpoint
    ADD CONSTRAINT endpoint_pkey PRIMARY KEY (id);

ALTER TABLE ONLY guardrail_artifact
    ADD CONSTRAINT guardrail_artifact_pkey PRIMARY KEY (id);

ALTER TABLE ONLY guardrail
    ADD CONSTRAINT guardrail_creation_key_key UNIQUE (creation_key);

ALTER TABLE ONLY guardrail
    ADD CONSTRAINT guardrail_duplicate_key_key UNIQUE (duplicate_key);

ALTER TABLE ONLY guardrail_package
    ADD CONSTRAINT guardrail_package_pkey PRIMARY KEY (id);

ALTER TABLE ONLY guardrail
    ADD CONSTRAINT guardrail_pkey PRIMARY KEY (id);

ALTER TABLE ONLY guardrail_profile
    ADD CONSTRAINT guardrail_profile_pkey PRIMARY KEY (id);

ALTER TABLE ONLY guardrail_test_case
    ADD CONSTRAINT guardrail_test_case_guardrail_id_id_pk PRIMARY KEY (guardrail_id, id);

ALTER TABLE ONLY validation_report_case
    ADD CONSTRAINT guardrail_validation_case_identity_idx UNIQUE (run_id, case_id);

ALTER TABLE ONLY validation_report_case
    ADD CONSTRAINT guardrail_validation_case_pkey PRIMARY KEY (run_id, ordinal);

ALTER TABLE ONLY validation_report_chunk
    ADD CONSTRAINT guardrail_validation_chunk_pkey PRIMARY KEY (run_id, sequence);

ALTER TABLE ONLY guardrail_validation_run
    ADD CONSTRAINT guardrail_validation_run_pkey PRIMARY KEY (id);

ALTER TABLE ONLY guardrail_validation_snapshot
    ADD CONSTRAINT guardrail_validation_snapshot_pkey PRIMARY KEY (digest);

ALTER TABLE ONLY validation_report_upload
    ADD CONSTRAINT guardrail_validation_upload_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY guardrail_version
    ADD CONSTRAINT guardrail_version_guardrail_id_version_pk PRIMARY KEY (guardrail_id, version);

ALTER TABLE ONLY guardrail_version_provenance
    ADD CONSTRAINT guardrail_version_provenance_pkey PRIMARY KEY (guardrail_id, version);

ALTER TABLE ONLY model_assignment_validation
    ADD CONSTRAINT model_assignment_validation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY model_configuration_revision
    ADD CONSTRAINT model_configuration_revision_pkey PRIMARY KEY (id);

ALTER TABLE ONLY model_definition
    ADD CONSTRAINT model_definition_pkey PRIMARY KEY (id);

ALTER TABLE ONLY model_price_revision
    ADD CONSTRAINT model_price_revision_pkey PRIMARY KEY (id);

ALTER TABLE ONLY model_price_sync
    ADD CONSTRAINT model_price_sync_pkey PRIMARY KEY (id);

ALTER TABLE ONLY model_provider
    ADD CONSTRAINT model_provider_pkey PRIMARY KEY (id);

ALTER TABLE ONLY model_usage_cost
    ADD CONSTRAINT model_usage_cost_pkey PRIMARY KEY (id);

ALTER TABLE ONLY personal_access_token
    ADD CONSTRAINT personal_access_token_pkey PRIMARY KEY (id);

ALTER TABLE ONLY personal_access_token
    ADD CONSTRAINT personal_access_token_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY policy_imported_version
    ADD CONSTRAINT policy_imported_version_pkey PRIMARY KEY (policy_id, version);

ALTER TABLE ONLY policy_record
    ADD CONSTRAINT policy_record_pkey PRIMARY KEY (id);

ALTER TABLE ONLY policy_resource
    ADD CONSTRAINT policy_resource_pkey PRIMARY KEY (id);

ALTER TABLE ONLY policy_resource_validation
    ADD CONSTRAINT policy_resource_validation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY policy_resource_version
    ADD CONSTRAINT policy_resource_version_pkey PRIMARY KEY (policy_id, version);

ALTER TABLE ONLY policy_resource_version
    ADD CONSTRAINT policy_resource_version_policy_id_revision_key UNIQUE (policy_id, revision);

ALTER TABLE ONLY policy_validation_run
    ADD CONSTRAINT policy_validation_run_pkey PRIMARY KEY (id);

ALTER TABLE ONLY policy_version
    ADD CONSTRAINT policy_version_policy_id_version_pk PRIMARY KEY (policy_id, version);

ALTER TABLE ONLY route_assignment
    ADD CONSTRAINT route_assignment_pkey PRIMARY KEY (decision_id);

ALTER TABLE ONLY runner_instance
    ADD CONSTRAINT runner_instance_pkey PRIMARY KEY (runner_id);

ALTER TABLE ONLY runner_pool
    ADD CONSTRAINT runner_pool_pkey PRIMARY KEY (id);

ALTER TABLE ONLY runtime_event
    ADD CONSTRAINT runtime_event_pkey PRIMARY KEY (id);

ALTER TABLE ONLY telemetry_watermark
    ADD CONSTRAINT telemetry_watermark_pkey PRIMARY KEY (runner_id);

ALTER TABLE ONLY traffic_router_change_request
    ADD CONSTRAINT traffic_router_change_request_pkey PRIMARY KEY (id);

ALTER TABLE ONLY traffic_router
    ADD CONSTRAINT traffic_router_pkey PRIMARY KEY (id);

ALTER TABLE ONLY traffic_router_revision
    ADD CONSTRAINT traffic_router_revision_pkey PRIMARY KEY (router_id, revision);

ALTER TABLE ONLY traffic_router_revision
    ADD CONSTRAINT traffic_router_revision_router_id_idempotency_key_key UNIQUE (router_id, idempotency_key);

ALTER TABLE ONLY validation_report_detail
    ADD CONSTRAINT validation_report_detail_pkey PRIMARY KEY (id);

ALTER TABLE ONLY validation_report
    ADD CONSTRAINT validation_report_guardrail_run_id_key UNIQUE (guardrail_run_id);

ALTER TABLE ONLY validation_report
    ADD CONSTRAINT validation_report_pkey PRIMARY KEY (id);

ALTER TABLE ONLY validation_report
    ADD CONSTRAINT validation_report_policy_job_id_key UNIQUE (policy_job_id);

ALTER TABLE ONLY validation_report
    ADD CONSTRAINT validation_report_policy_run_id_key UNIQUE (policy_run_id);

CREATE INDEX audit_resource_idx ON audit_event USING btree (resource_type, resource_id);

CREATE INDEX audit_time_id_idx ON audit_event USING btree (occurred_at DESC, id DESC);

CREATE UNIQUE INDEX auth_account_issuer_idx ON auth_account USING btree (issuer, account_id);

CREATE INDEX auth_account_user_idx ON auth_account USING btree (user_id);

CREATE INDEX auth_session_user_idx ON auth_session USING btree (user_id);

CREATE UNIQUE INDEX auth_user_username_unique ON auth_user USING btree (username);

CREATE INDEX auth_verification_identifier_idx ON auth_verification USING btree (identifier);

CREATE INDEX controller_outbox_pending_idx ON controller_outbox USING btree (processed_at, available_at);

CREATE INDEX endpoint_status_idx ON endpoint USING btree (status);

CREATE INDEX endpoint_traffic_router_idx ON endpoint USING btree (traffic_router_id);

CREATE UNIQUE INDEX guardrail_artifact_checksum_idx ON guardrail_artifact USING btree (checksum);

CREATE INDEX guardrail_artifact_version_idx ON guardrail_artifact USING btree (guardrail_id, guardrail_version);

CREATE UNIQUE INDEX guardrail_profile_category_default_idx ON guardrail_profile USING btree (category) WHERE (is_default AND enabled);

CREATE INDEX guardrail_status_idx ON guardrail USING btree (status);

CREATE INDEX guardrail_test_case_guardrail_idx ON guardrail_test_case USING btree (guardrail_id);

CREATE INDEX guardrail_validation_case_page_idx ON validation_report_case USING btree (run_id, priority, ordinal);

CREATE INDEX guardrail_validation_case_status_idx ON validation_report_case USING btree (run_id, status, priority, ordinal);

CREATE INDEX guardrail_validation_retention_idx ON guardrail_validation_run USING btree (guardrail_id, status, COALESCE(completed_at, created_at) DESC, id DESC);

CREATE INDEX guardrail_validation_run_guardrail_idx ON guardrail_validation_run USING btree (guardrail_id, created_at);

CREATE INDEX guardrail_validation_snapshot_digest_idx ON guardrail_validation_run USING btree (snapshot_digest);

CREATE UNIQUE INDEX guardrail_version_generation_idx ON guardrail_version USING btree (generation);

CREATE INDEX model_assignment_validation_lookup_idx ON model_assignment_validation USING btree (actor_id, target, model_id, created_at);

CREATE UNIQUE INDEX model_configuration_revision_number_idx ON model_configuration_revision USING btree (revision);

CREATE INDEX model_configuration_revision_state_idx ON model_configuration_revision USING btree (state);

CREATE INDEX model_definition_provider_idx ON model_definition USING btree (provider_id);

CREATE UNIQUE INDEX model_definition_provider_model_idx ON model_definition USING btree (provider_id, model, profile);

CREATE INDEX model_definition_status_idx ON model_definition USING btree (status);

CREATE INDEX model_price_revision_lookup_idx ON model_price_revision USING btree (key, effective_at DESC);

CREATE UNIQUE INDEX model_provider_name_idx ON model_provider USING btree (name);

CREATE INDEX model_provider_status_idx ON model_provider USING btree (status);

CREATE INDEX model_usage_cost_event_idx ON model_usage_cost USING btree (event_id);

CREATE INDEX model_usage_cost_guardrail_time_idx ON model_usage_cost USING btree (guardrail_id, occurred_at);

CREATE INDEX personal_access_token_user_idx ON personal_access_token USING btree (user_id);

CREATE INDEX policy_record_name_idx ON policy_record USING btree (name);

CREATE INDEX policy_resource_validation_parent_idx ON policy_resource_validation USING btree (parent_id);

CREATE INDEX policy_resource_validation_policy_idx ON policy_resource_validation USING btree (policy_id, created_at);

CREATE INDEX policy_validation_run_policy_idx ON policy_validation_run USING btree (policy_id, created_at);

CREATE UNIQUE INDEX policy_version_checksum_idx ON policy_version USING btree (checksum);

CREATE UNIQUE INDEX policy_version_source_draft_idx ON policy_version USING btree (policy_id, source_draft_revision);

CREATE INDEX route_assignment_guardrail_idx ON route_assignment USING btree (guardrail_id);

CREATE INDEX route_assignment_router_time_idx ON route_assignment USING btree (router_id, occurred_at);

CREATE INDEX runner_instance_pool_idx ON runner_instance USING btree (pool_id);

CREATE UNIQUE INDEX runner_pool_single_default_idx ON runner_pool USING btree (is_default) WHERE (is_default = true);

CREATE INDEX runtime_event_endpoint_direction_time_idx ON runtime_event USING btree (endpoint_id, direction, occurred_at);

CREATE INDEX runtime_event_endpoint_error_time_idx ON runtime_event USING btree (endpoint_id, occurred_at) WHERE (lower(decision) = ANY (ARRAY['error'::text, 'failed'::text, 'failure'::text, 'timeout'::text, 'timed_out'::text]));

CREATE INDEX runtime_event_endpoint_final_time_idx ON runtime_event USING btree (endpoint_id, occurred_at) WHERE ((metadata ->> 'streamFinalCheck'::text) = 'true'::text);

CREATE INDEX runtime_event_endpoint_time_idx ON runtime_event USING btree (endpoint_id, occurred_at);

CREATE INDEX runtime_event_guardrail_time_id_idx ON runtime_event USING btree (guardrail_id, occurred_at, id);

CREATE INDEX runtime_event_request_time_idx ON runtime_event USING btree (request_id, occurred_at, id);

CREATE INDEX runtime_event_router_time_idx ON runtime_event USING btree (router_id, occurred_at, id);

CREATE INDEX runtime_event_time_id_idx ON runtime_event USING btree (occurred_at, id);

CREATE UNIQUE INDEX traffic_router_change_request_pending_idx ON traffic_router_change_request USING btree (router_id) WHERE (status = 'pending'::text);

CREATE INDEX traffic_router_change_request_router_idx ON traffic_router_change_request USING btree (router_id, submitted_at);

CREATE INDEX validation_report_case_detail_idx ON validation_report_case USING btree (detail_id);

CREATE INDEX validation_report_detail_owner_idx ON validation_report_detail USING btree (owner_id);

CREATE TRIGGER register_report AFTER INSERT ON guardrail_validation_run FOR EACH ROW EXECUTE FUNCTION register_validation_report();

CREATE TRIGGER register_report AFTER INSERT ON policy_resource_validation FOR EACH ROW EXECUTE FUNCTION register_validation_report();

CREATE TRIGGER register_report AFTER INSERT ON policy_validation_run FOR EACH ROW EXECUTE FUNCTION register_validation_report();

ALTER TABLE ONLY audit_event
    ADD CONSTRAINT audit_event_actor_id_auth_user_id_fk FOREIGN KEY (actor_id) REFERENCES auth_user(id);

ALTER TABLE ONLY auth_account
    ADD CONSTRAINT auth_account_user_id_auth_user_id_fk FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth_session
    ADD CONSTRAINT auth_session_user_id_auth_user_id_fk FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY endpoint
    ADD CONSTRAINT endpoint_deleted_by_auth_user_id_fk FOREIGN KEY (deleted_by) REFERENCES auth_user(id);

ALTER TABLE ONLY endpoint
    ADD CONSTRAINT endpoint_traffic_router_id_fkey FOREIGN KEY (traffic_router_id) REFERENCES traffic_router(id);

ALTER TABLE ONLY guardrail_artifact
    ADD CONSTRAINT guardrail_artifact_guardrail_id_guardrail_id_fk FOREIGN KEY (guardrail_id) REFERENCES guardrail(id);

ALTER TABLE ONLY guardrail
    ADD CONSTRAINT guardrail_deleted_by_auth_user_id_fk FOREIGN KEY (deleted_by) REFERENCES auth_user(id);

ALTER TABLE ONLY guardrail_package
    ADD CONSTRAINT guardrail_package_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES auth_user(id);

ALTER TABLE ONLY guardrail
    ADD CONSTRAINT guardrail_protection_mode_updated_by_fkey FOREIGN KEY (protection_mode_updated_by) REFERENCES auth_user(id);

ALTER TABLE ONLY guardrail_test_case
    ADD CONSTRAINT guardrail_test_case_guardrail_id_guardrail_id_fk FOREIGN KEY (guardrail_id) REFERENCES guardrail(id);

ALTER TABLE ONLY validation_report_chunk
    ADD CONSTRAINT guardrail_validation_chunk_run_id_fkey FOREIGN KEY (run_id) REFERENCES validation_report_upload(run_id) ON DELETE CASCADE;

ALTER TABLE ONLY guardrail_validation_run
    ADD CONSTRAINT guardrail_validation_run_created_by_auth_user_id_fk FOREIGN KEY (created_by) REFERENCES auth_user(id);

ALTER TABLE ONLY guardrail_validation_run
    ADD CONSTRAINT guardrail_validation_run_guardrail_id_guardrail_id_fk FOREIGN KEY (guardrail_id) REFERENCES guardrail(id);

ALTER TABLE ONLY guardrail_validation_run
    ADD CONSTRAINT guardrail_validation_snapshot_ref FOREIGN KEY (snapshot_digest) REFERENCES guardrail_validation_snapshot(digest);

ALTER TABLE ONLY guardrail_version
    ADD CONSTRAINT guardrail_version_created_by_auth_user_id_fk FOREIGN KEY (created_by) REFERENCES auth_user(id);

ALTER TABLE ONLY guardrail_version
    ADD CONSTRAINT guardrail_version_guardrail_id_guardrail_id_fk FOREIGN KEY (guardrail_id) REFERENCES guardrail(id);

ALTER TABLE ONLY guardrail_version_provenance
    ADD CONSTRAINT guardrail_version_provenance_guardrail_id_version_fkey FOREIGN KEY (guardrail_id, version) REFERENCES guardrail_version(guardrail_id, version) ON DELETE CASCADE;

ALTER TABLE ONLY guardrail_version_provenance
    ADD CONSTRAINT guardrail_version_provenance_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES auth_user(id);

ALTER TABLE ONLY guardrail_version_provenance
    ADD CONSTRAINT guardrail_version_provenance_package_id_fkey FOREIGN KEY (package_id) REFERENCES guardrail_package(id);

ALTER TABLE ONLY guardrail_version
    ADD CONSTRAINT guardrail_version_released_by_fkey FOREIGN KEY (released_by) REFERENCES auth_user(id);

ALTER TABLE ONLY model_assignment_validation
    ADD CONSTRAINT model_assignment_validation_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY model_assignment_validation
    ADD CONSTRAINT model_assignment_validation_model_id_fkey FOREIGN KEY (model_id) REFERENCES model_definition(id) ON DELETE CASCADE;

ALTER TABLE ONLY model_configuration_revision
    ADD CONSTRAINT model_configuration_revision_created_by_auth_user_id_fk FOREIGN KEY (created_by) REFERENCES auth_user(id);

ALTER TABLE ONLY model_definition
    ADD CONSTRAINT model_definition_created_by_auth_user_id_fk FOREIGN KEY (created_by) REFERENCES auth_user(id);

ALTER TABLE ONLY model_definition
    ADD CONSTRAINT model_definition_provider_id_model_provider_id_fk FOREIGN KEY (provider_id) REFERENCES model_provider(id) ON DELETE RESTRICT;

ALTER TABLE ONLY model_provider
    ADD CONSTRAINT model_provider_created_by_auth_user_id_fk FOREIGN KEY (created_by) REFERENCES auth_user(id);

ALTER TABLE ONLY personal_access_token
    ADD CONSTRAINT personal_access_token_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY policy_imported_version
    ADD CONSTRAINT policy_imported_version_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES auth_user(id);

ALTER TABLE ONLY policy_imported_version
    ADD CONSTRAINT policy_imported_version_package_id_fkey FOREIGN KEY (package_id) REFERENCES guardrail_package(id) ON DELETE SET NULL;

ALTER TABLE ONLY policy_resource_validation
    ADD CONSTRAINT policy_resource_validation_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES policy_resource(id);

ALTER TABLE ONLY policy_resource_version
    ADD CONSTRAINT policy_resource_version_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES policy_resource(id);

ALTER TABLE ONLY policy_validation_run
    ADD CONSTRAINT policy_validation_run_created_by_auth_user_id_fk FOREIGN KEY (created_by) REFERENCES auth_user(id);

ALTER TABLE ONLY policy_validation_run
    ADD CONSTRAINT policy_validation_run_policy_id_policy_record_id_fk FOREIGN KEY (policy_id) REFERENCES policy_record(id) ON DELETE CASCADE;

ALTER TABLE ONLY policy_version
    ADD CONSTRAINT policy_version_policy_id_policy_record_id_fk FOREIGN KEY (policy_id) REFERENCES policy_record(id) ON DELETE CASCADE;

ALTER TABLE ONLY runner_instance
    ADD CONSTRAINT runner_instance_pool_id_runner_pool_id_fk FOREIGN KEY (pool_id) REFERENCES runner_pool(id);

ALTER TABLE ONLY traffic_router_change_request
    ADD CONSTRAINT traffic_router_change_request_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES auth_user(id);

ALTER TABLE ONLY traffic_router_change_request
    ADD CONSTRAINT traffic_router_change_request_reverts_change_request_id_fkey FOREIGN KEY (reverts_change_request_id) REFERENCES traffic_router_change_request(id);

ALTER TABLE ONLY traffic_router_change_request
    ADD CONSTRAINT traffic_router_change_request_router_id_fkey FOREIGN KEY (router_id) REFERENCES traffic_router(id);

ALTER TABLE ONLY traffic_router_change_request
    ADD CONSTRAINT traffic_router_change_request_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES auth_user(id);

ALTER TABLE ONLY traffic_router_revision
    ADD CONSTRAINT traffic_router_revision_change_request_id_fkey FOREIGN KEY (change_request_id) REFERENCES traffic_router_change_request(id);

ALTER TABLE ONLY traffic_router_revision
    ADD CONSTRAINT traffic_router_revision_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth_user(id);

ALTER TABLE ONLY traffic_router_revision
    ADD CONSTRAINT traffic_router_revision_router_id_fkey FOREIGN KEY (router_id) REFERENCES traffic_router(id);

ALTER TABLE ONLY validation_report_case
    ADD CONSTRAINT validation_report_case_detail_id_fkey FOREIGN KEY (detail_id) REFERENCES validation_report_detail(id) ON DELETE CASCADE;

ALTER TABLE ONLY validation_report_case
    ADD CONSTRAINT validation_report_case_run_id_fkey FOREIGN KEY (run_id) REFERENCES validation_report(id) ON DELETE CASCADE;

ALTER TABLE ONLY validation_report_detail
    ADD CONSTRAINT validation_report_detail_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES validation_report(id) ON DELETE CASCADE;

ALTER TABLE ONLY validation_report
    ADD CONSTRAINT validation_report_guardrail_run_id_fkey FOREIGN KEY (guardrail_run_id) REFERENCES guardrail_validation_run(id) ON DELETE CASCADE;

ALTER TABLE ONLY validation_report
    ADD CONSTRAINT validation_report_policy_job_id_fkey FOREIGN KEY (policy_job_id) REFERENCES policy_resource_validation(id) ON DELETE CASCADE;

ALTER TABLE ONLY validation_report
    ADD CONSTRAINT validation_report_policy_run_id_fkey FOREIGN KEY (policy_run_id) REFERENCES policy_validation_run(id) ON DELETE CASCADE;

ALTER TABLE ONLY validation_report_upload
    ADD CONSTRAINT validation_report_upload_run_id_fkey FOREIGN KEY (run_id) REFERENCES validation_report(id) ON DELETE CASCADE;
