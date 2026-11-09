-- Development baseline. Existing development databases must be recreated.
CREATE FUNCTION "public".protect_endpoint_telemetry_context() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.retired_at IS NULL OR OLD.retired_at > clock_timestamp() - interval '31 days'
      OR EXISTS (SELECT 1 FROM runtime_event WHERE allocation_context_id = OLD.id)
      OR EXISTS (SELECT 1 FROM model_usage_cost WHERE allocation_context_id = OLD.id)
      OR EXISTS (SELECT 1 FROM route_assignment WHERE allocation_context_id = OLD.id) THEN
      RAISE EXCEPTION 'Endpoint telemetry context is active, retained or referenced';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - 'retired_at' - 'payload_bytes') IS DISTINCT FROM (to_jsonb(OLD) - 'retired_at' - 'payload_bytes')
    OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
    RAISE EXCEPTION 'Endpoint telemetry context authority is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "public".protect_group_model_configuration() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM project_group WHERE id=OLD.group_id) THEN
      RAISE EXCEPTION 'Replace group model policy explicitly; deletion cannot restore platform authority';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.group_id IS DISTINCT FROM OLD.group_id OR NEW.version <> OLD.version + 1 OR NEW.id = OLD.id OR NEW.generation <= OLD.generation THEN
    RAISE EXCEPTION 'Group model policy replacement requires a fresh identity and next version';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "public".protect_project_name() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    RAISE EXCEPTION 'Project names are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "public".register_validation_report() RETURNS trigger
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

CREATE FUNCTION "public".set_audit_event_project() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  owner_id text;
  owner_count integer;
BEGIN
  -- Derive ownership from the resource, not the actor. A platform admin may
  -- act on a resource owned by any project. NULL is intentionally platform-only.
  IF NEW.resource_type = 'guardrail' THEN
    SELECT project_id INTO owner_id FROM guardrail WHERE id = NEW.resource_id;
  ELSIF NEW.resource_type = 'endpoint' THEN
    SELECT project_id INTO owner_id FROM endpoint WHERE id = NEW.resource_id;
  ELSIF NEW.resource_type = 'router' THEN
    SELECT project_id INTO owner_id FROM traffic_router WHERE id = NEW.resource_id;
  ELSIF NEW.resource_type = 'policy' THEN
    SELECT COUNT(DISTINCT project_id), MIN(project_id) INTO owner_count, owner_id FROM (
      SELECT project_id FROM policy_resource WHERE id = NEW.resource_id
      UNION ALL SELECT project_id FROM policy_record WHERE id = NEW.resource_id
      UNION ALL SELECT project_id FROM policy_imported_version WHERE policy_id = NEW.resource_id
    ) AS policy_owners;
    IF owner_count > 1 THEN owner_id := NULL; END IF;
    -- The hard-delete path captures the owner from locked records before
    -- removing them. This value is Controller-produced, not request input.
    IF owner_count = 0 AND NEW.kind = 'policy.deleted' THEN
      owner_id := NEW.project_id;
    END IF;
  ELSIF NEW.resource_type IN ('model', 'model_definition') THEN
    SELECT project_id INTO owner_id FROM model_definition WHERE id = NEW.resource_id;
  ELSIF NEW.resource_type = 'access_token' THEN
    SELECT project_id INTO owner_id FROM personal_access_token WHERE id=NEW.resource_id AND user_id=NEW.actor_id;
  END IF;
  NEW.project_id := owner_id;
  RETURN NEW;
END;
$$;

CREATE TABLE "public".audit_event (
    id text NOT NULL,
    kind text NOT NULL,
    actor_id text,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    project_id text
);

CREATE TABLE "public".auth_account (
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

CREATE TABLE "public".auth_session (
    id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    token text NOT NULL,
    ip_address text,
    user_agent text,
    impersonated_by text,
    user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    active_project_id text
);

CREATE TABLE "public".auth_user (
    id text NOT NULL,
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
    username text,
    sso_project_grants jsonb DEFAULT '[]'::jsonb NOT NULL,
    sso_verified_at timestamp with time zone
);

CREATE TABLE "public".auth_verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "public".controller_outbox (
    id text NOT NULL,
    kind text NOT NULL,
    aggregate_id text NOT NULL,
    payload jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "public".controller_state (
    id text NOT NULL,
    desired_generation bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "public".deployment_preset (
    key text NOT NULL,
    guardrail_id text NOT NULL,
    profile_id text NOT NULL,
    profile_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "public".endpoint (
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
    scan_flag_only_default boolean DEFAULT true NOT NULL,
    credential_required boolean DEFAULT true NOT NULL,
    project_id text NOT NULL
);

CREATE TABLE "public".endpoint_telemetry_context (
    id text NOT NULL,
    snapshot_key text NOT NULL,
    project_id text NOT NULL,
    group_id text NOT NULL,
    pool_id text NOT NULL,
    allocation_epoch bigint NOT NULL,
    generation bigint NOT NULL,
    endpoint_id text NOT NULL,
    adapter text NOT NULL,
    verification_digest text NOT NULL,
    endpoint_snapshot_digest text NOT NULL,
    router_id text,
    router_revision bigint,
    router_snapshot_digest text,
    targets jsonb DEFAULT '[]'::jsonb NOT NULL,
    issued_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    retired_at timestamp with time zone,
    payload_bytes bigint GENERATED ALWAYS AS ((((((((((((((128)::bigint + octet_length(id)) + octet_length(snapshot_key)) + octet_length(project_id)) + octet_length(group_id)) + octet_length(pool_id)) + octet_length(endpoint_id)) + octet_length(adapter)) + octet_length(verification_digest)) + octet_length(endpoint_snapshot_digest)) + octet_length(COALESCE(router_id, ''::text))) + octet_length(COALESCE(router_snapshot_digest, ''::text))) + octet_length((targets)::text))) STORED NOT NULL,
    CONSTRAINT endpoint_telemetry_context_allocation_epoch_check CHECK ((allocation_epoch >= 0)),
    CONSTRAINT endpoint_telemetry_context_check CHECK ((((router_id IS NULL) AND (router_revision IS NULL) AND (router_snapshot_digest IS NULL)) OR ((router_id IS NOT NULL) AND (router_revision > 0) AND (router_snapshot_digest IS NOT NULL)))),
    CONSTRAINT endpoint_telemetry_context_generation_check CHECK ((generation >= 0))
);

CREATE TABLE "public".guardrail (
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
    project_id text,
    CONSTRAINT guardrail_origin_ck CHECK ((((origin = 'local'::text) AND (source_id IS NULL)) OR ((origin = 'imported'::text) AND (source_id IS NOT NULL)))),
    CONSTRAINT guardrail_protection_mode_applied_check CHECK ((protection_mode_applied = ANY (ARRAY['enforce'::text, 'monitor'::text, 'bypass'::text]))),
    CONSTRAINT guardrail_protection_mode_check CHECK ((protection_mode = ANY (ARRAY['enforce'::text, 'monitor'::text, 'bypass'::text])))
);

CREATE TABLE "public".guardrail_artifact (
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

CREATE TABLE "public".guardrail_package (
    id text NOT NULL,
    content bytea NOT NULL,
    size_bytes integer NOT NULL,
    source_id text NOT NULL,
    key_id text,
    guardrail_id text NOT NULL,
    manifest jsonb NOT NULL,
    uploaded_by text,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    last_imported_at timestamp with time zone,
    project_id text NOT NULL
);

CREATE TABLE "public".guardrail_profile (
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

CREATE TABLE "public".guardrail_test_case (
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

CREATE TABLE "public".guardrail_validation_run (
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

CREATE TABLE "public".guardrail_validation_snapshot (
    digest text NOT NULL,
    payload jsonb NOT NULL
);

CREATE TABLE "public".guardrail_version (
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

CREATE TABLE "public".guardrail_version_provenance (
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

CREATE TABLE "public".model_assignment_validation (
    id text NOT NULL,
    actor_id text NOT NULL,
    target text NOT NULL,
    model_id text NOT NULL,
    fingerprint text NOT NULL,
    evidence jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "public".model_configuration_revision (
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
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    project_id text
);

CREATE TABLE "public".model_definition (
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
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    max_concurrency integer DEFAULT 2 NOT NULL,
    project_id text
);

CREATE TABLE "public".model_price_revision (
    id text NOT NULL,
    key text NOT NULL,
    source text NOT NULL,
    catalog_key text,
    rates jsonb,
    effective_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "public".model_price_sync (
    id text NOT NULL,
    catalog_version text,
    last_success_at timestamp with time zone,
    error text,
    entries integer DEFAULT 0 NOT NULL,
    metering_since timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "public".model_provider (
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

CREATE TABLE "public".model_usage_cost (
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
    project_id text,
    allocation_context_id text,
    CONSTRAINT model_usage_cost_currency_check CHECK ((currency = 'USD'::text))
);

CREATE TABLE "public".model_validation_credential_lease (
    id text NOT NULL,
    provider_id text NOT NULL,
    credential_ciphertext text NOT NULL,
    pool_id text,
    group_id text,
    allocation_epoch bigint,
    runner_id text,
    boot_id text,
    control_session_id text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '00:01:35'::interval) NOT NULL,
    CONSTRAINT model_validation_credential_lease_allocation_epoch_check CHECK ((allocation_epoch >= 0)),
    CONSTRAINT model_validation_credential_lease_check CHECK ((((pool_id IS NULL) AND (group_id IS NULL) AND (allocation_epoch IS NULL)) OR ((pool_id IS NOT NULL) AND (group_id IS NOT NULL) AND (allocation_epoch IS NOT NULL)))),
    CONSTRAINT model_validation_credential_lease_check1 CHECK ((((runner_id IS NULL) AND (boot_id IS NULL) AND (control_session_id IS NULL)) OR ((runner_id IS NOT NULL) AND (boot_id IS NOT NULL) AND (control_session_id IS NOT NULL) AND (pool_id IS NOT NULL)))),
    CONSTRAINT model_validation_credential_lease_check2 CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:01:36'::interval))))
);

CREATE TABLE "public".personal_access_token (
    id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    prefix text NOT NULL,
    token_hash text NOT NULL,
    permissions jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    project_id text
);

CREATE TABLE "public".playground_invocation (
    call_id text NOT NULL,
    project_id text NOT NULL,
    guardrail_id text NOT NULL,
    guardrail_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    pool_id text,
    group_id text,
    CONSTRAINT playground_invocation_allocation_pair CHECK ((((pool_id IS NULL) AND (group_id IS NULL)) OR ((pool_id IS NOT NULL) AND (length(pool_id) > 0) AND (group_id IS NOT NULL) AND (length(group_id) > 0))))
);

CREATE TABLE "public".policy_imported_version (
    policy_id text NOT NULL,
    version text NOT NULL,
    digest text NOT NULL,
    definition jsonb NOT NULL,
    source_id text NOT NULL,
    package_id text,
    imported_by text,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    project_id text NOT NULL
);

CREATE TABLE "public".policy_record (
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
    project_id text NOT NULL,
    CONSTRAINT policy_record_origin_ck CHECK ((((origin = 'local'::text) AND (source_id IS NULL)) OR ((origin = 'imported'::text) AND (source_id IS NOT NULL))))
);

CREATE TABLE "public".policy_resource (
    id text NOT NULL,
    definition jsonb NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    maintainer text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    project_id text NOT NULL
);

CREATE TABLE "public".policy_resource_validation (
    id text NOT NULL,
    policy_id text NOT NULL,
    parent_id text,
    revision integer NOT NULL,
    status text NOT NULL,
    tests jsonb NOT NULL,
    failure_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "public".policy_resource_version (
    policy_id text NOT NULL,
    version text NOT NULL,
    revision integer NOT NULL,
    definition jsonb NOT NULL,
    view jsonb NOT NULL,
    digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "public".policy_validation_run (
    id text NOT NULL,
    policy_id text NOT NULL,
    draft_revision integer NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    failure_reason text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);

CREATE TABLE "public".policy_version (
    policy_id text NOT NULL,
    version integer NOT NULL,
    snapshot jsonb NOT NULL,
    checksum text NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    source_draft_revision integer
);

CREATE TABLE "public".project (
    id text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    group_id text DEFAULT 'default'::text NOT NULL,
    external_department_id text
);

CREATE TABLE "public".project_group (
    id text NOT NULL,
    name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "public".project_group_model_configuration (
    group_id text NOT NULL,
    id text NOT NULL,
    version bigint NOT NULL,
    mode text NOT NULL,
    source_revision_id text,
    source_fingerprint text,
    runtime_payload jsonb,
    credential_ciphertexts jsonb DEFAULT '{}'::jsonb NOT NULL,
    snapshot_digest text,
    generation bigint NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT project_group_model_configuration_check CHECK ((((mode = 'scoped'::text) AND (source_revision_id IS NOT NULL) AND (source_fingerprint ~ '^[a-f0-9]{64}$'::text) AND (runtime_payload IS NOT NULL) AND (snapshot_digest ~ '^[a-f0-9]{64}$'::text)) OR ((mode = ANY (ARRAY['platform'::text, 'blocked'::text])) AND (source_revision_id IS NULL) AND (source_fingerprint IS NULL) AND (runtime_payload IS NULL) AND (credential_ciphertexts = '{}'::jsonb) AND (snapshot_digest IS NULL)))),
    CONSTRAINT project_group_model_configuration_check1 CHECK (((octet_length(COALESCE((runtime_payload)::text, ''::text)) + octet_length((credential_ciphertexts)::text)) <= 262144)),
    CONSTRAINT project_group_model_configuration_generation_check CHECK (((generation >= 0) AND (generation <= '9007199254740991'::bigint))),
    CONSTRAINT project_group_model_configuration_mode_check CHECK ((mode = ANY (ARRAY['platform'::text, 'scoped'::text, 'blocked'::text]))),
    CONSTRAINT project_group_model_configuration_version_check CHECK (((version >= 1) AND (version <= '9007199254740991'::bigint)))
);

CREATE TABLE "public".project_member (
    project_id text NOT NULL,
    user_id text NOT NULL,
    source text DEFAULT 'local'::text NOT NULL,
    access text DEFAULT 'write'::text NOT NULL,
    roles jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_member_access_check CHECK ((access = ANY (ARRAY['read'::text, 'write'::text]))),
    CONSTRAINT project_member_source_check CHECK ((source = ANY (ARRAY['local'::text, 'sso'::text])))
);

CREATE TABLE "public".resource_share (
    id text NOT NULL,
    owner_project_id text NOT NULL,
    recipient_project_id text NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT resource_share_distinct_projects CHECK ((owner_project_id <> recipient_project_id)),
    CONSTRAINT resource_share_kind CHECK ((resource_type = ANY (ARRAY['policy'::text, 'guardrail'::text, 'endpoint'::text, 'router'::text, 'model'::text])))
);

CREATE TABLE "public".route_assignment (
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
    duration_ms integer,
    project_id text,
    allocation_context_id text
);

CREATE TABLE "public".runner_control_session (
    id text NOT NULL,
    runner_id text NOT NULL,
    boot_id text NOT NULL,
    pool_id text NOT NULL,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    disconnected_at timestamp with time zone,
    snapshot_nonce text,
    snapshot_generation bigint,
    snapshot_model_revision_id text,
    snapshot_epoch bigint,
    snapshot_group_id text,
    snapshot_dispatched_at timestamp with time zone,
    snapshot_acknowledged_at timestamp with time zone,
    snapshot_accepted boolean DEFAULT false NOT NULL
);

CREATE TABLE "public".runner_instance (
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
    protection_error text,
    control_session_id text
);

CREATE TABLE "public".runner_pool (
    id text NOT NULL,
    name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    desired_replicas integer DEFAULT 1 NOT NULL,
    safe_rps_per_runner double precision DEFAULT 1 NOT NULL,
    max_concurrency_per_runner integer DEFAULT 64 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    group_id text DEFAULT 'default'::text NOT NULL,
    runtime_url text,
    public_url text,
    project_id text,
    CONSTRAINT runner_pool_project_required CHECK ((((id = 'default'::text) AND (project_id IS NULL)) OR ((id <> 'default'::text) AND (project_id IS NOT NULL))))
);

CREATE TABLE "public".runner_pool_lease_epoch (
    pool_id text NOT NULL,
    epoch bigint DEFAULT 0 NOT NULL,
    draining boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runner_pool_lease_epoch_epoch_check CHECK ((epoch >= 0))
);

CREATE TABLE "public".runner_serving_grant (
    pool_id text NOT NULL,
    runner_id text NOT NULL,
    boot_id text NOT NULL,
    nonce text NOT NULL,
    epoch bigint NOT NULL,
    generation bigint NOT NULL,
    duration_ms integer NOT NULL,
    uncertainty_ms integer NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    conservative_expires_at timestamp with time zone NOT NULL,
    snapshot_nonce text,
    model_revision_id text,
    control_session_id text,
    CONSTRAINT runner_serving_grant_duration_ms_check CHECK ((duration_ms > 0)),
    CONSTRAINT runner_serving_grant_epoch_check CHECK ((epoch >= 0)),
    CONSTRAINT runner_serving_grant_generation_check CHECK ((generation >= 0)),
    CONSTRAINT runner_serving_grant_snapshot_pair CHECK ((((snapshot_nonce IS NULL) AND (model_revision_id IS NULL)) OR ((snapshot_nonce IS NOT NULL) AND (length(snapshot_nonce) > 0) AND (model_revision_id IS NOT NULL)))),
    CONSTRAINT runner_serving_grant_uncertainty_ms_check CHECK ((uncertainty_ms >= 0))
);

CREATE TABLE "public".runner_telemetry_capability (
    control_session_id text NOT NULL,
    wal_id text NOT NULL,
    capability_hash text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runner_telemetry_capability_capability_hash_check CHECK ((capability_hash ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE "public".runner_telemetry_wal (
    runner_id text NOT NULL,
    pool_id text NOT NULL,
    wal_id text NOT NULL,
    acknowledged_cursor bigint DEFAULT 0 NOT NULL,
    produced_cursor bigint DEFAULT 0 NOT NULL,
    last_batch_id text,
    last_batch_digest text,
    last_batch_first bigint,
    last_batch_last bigint,
    received_at timestamp with time zone,
    caught_up_at timestamp with time zone,
    CONSTRAINT runner_telemetry_wal_check CHECK ((((acknowledged_cursor >= 0) AND (acknowledged_cursor <= '9007199254740991'::bigint)) AND ((produced_cursor >= acknowledged_cursor) AND (produced_cursor <= '9007199254740991'::bigint)))),
    CONSTRAINT runner_telemetry_wal_check1 CHECK ((((last_batch_id IS NULL) AND (last_batch_digest IS NULL) AND (last_batch_first IS NULL) AND (last_batch_last IS NULL)) OR ((last_batch_id IS NOT NULL) AND (last_batch_digest ~ '^[0-9a-f]{64}$'::text) AND (last_batch_first >= 1) AND (last_batch_last >= last_batch_first) AND (last_batch_last = acknowledged_cursor)))),
    CONSTRAINT runner_telemetry_wal_check2 CHECK (((caught_up_at IS NULL) OR (produced_cursor = acknowledged_cursor))),
    CONSTRAINT runner_telemetry_wal_wal_id_check CHECK ((wal_id ~ '^[0-9a-f-]{36}$'::text))
);

CREATE TABLE "public".runtime_event (
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
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    project_id text,
    allocation_context_id text
);

CREATE TABLE "public".telemetry_watermark (
    runner_id text NOT NULL,
    last_event_occurred_at timestamp with time zone,
    last_received_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "public".traffic_router (
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
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    project_id text NOT NULL
);

CREATE TABLE "public".traffic_router_change_request (
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

CREATE TABLE "public".traffic_router_revision (
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

CREATE TABLE "public".validation_report (
    id text NOT NULL,
    guardrail_run_id text,
    policy_run_id text,
    policy_job_id text,
    CONSTRAINT validation_report_check CHECK ((num_nonnulls(guardrail_run_id, policy_run_id, policy_job_id) = 1))
);

CREATE TABLE "public".validation_report_case (
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

CREATE TABLE "public".validation_report_chunk (
    run_id text NOT NULL,
    sequence integer NOT NULL,
    digest text NOT NULL,
    raw_bytes integer NOT NULL,
    case_offset integer NOT NULL,
    case_count integer NOT NULL
);

CREATE TABLE "public".validation_report_detail (
    id text NOT NULL,
    owner_id text NOT NULL,
    body jsonb NOT NULL,
    bytes integer NOT NULL,
    CONSTRAINT validation_report_detail_bytes_check CHECK ((bytes >= 0))
);

CREATE VIEW "public".validation_report_state AS
 SELECT guardrail_validation_run.id,
    guardrail_validation_run.status
   FROM "public".guardrail_validation_run
UNION ALL
 SELECT policy_validation_run.id,
    policy_validation_run.status
   FROM "public".policy_validation_run
UNION ALL
 SELECT policy_resource_validation.id,
    policy_resource_validation.status
   FROM "public".policy_resource_validation;

CREATE TABLE "public".validation_report_upload (
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

ALTER TABLE ONLY "public".audit_event
    ADD CONSTRAINT audit_event_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".auth_account
    ADD CONSTRAINT auth_account_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".auth_session
    ADD CONSTRAINT auth_session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".auth_session
    ADD CONSTRAINT auth_session_token_unique UNIQUE (token);

ALTER TABLE ONLY "public".auth_user
    ADD CONSTRAINT auth_user_email_unique UNIQUE (email);

ALTER TABLE ONLY "public".auth_user
    ADD CONSTRAINT auth_user_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".auth_verification
    ADD CONSTRAINT auth_verification_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".controller_outbox
    ADD CONSTRAINT controller_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".controller_state
    ADD CONSTRAINT controller_state_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".deployment_preset
    ADD CONSTRAINT deployment_preset_pkey PRIMARY KEY (key);

ALTER TABLE ONLY "public".endpoint
    ADD CONSTRAINT endpoint_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".endpoint_telemetry_context
    ADD CONSTRAINT endpoint_telemetry_context_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".endpoint_telemetry_context
    ADD CONSTRAINT endpoint_telemetry_context_snapshot_key_key UNIQUE (snapshot_key);

ALTER TABLE ONLY "public".guardrail_artifact
    ADD CONSTRAINT guardrail_artifact_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".guardrail
    ADD CONSTRAINT guardrail_creation_key_key UNIQUE (creation_key);

ALTER TABLE ONLY "public".guardrail
    ADD CONSTRAINT guardrail_duplicate_key_key UNIQUE (duplicate_key);

ALTER TABLE ONLY "public".guardrail_package
    ADD CONSTRAINT guardrail_package_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".guardrail
    ADD CONSTRAINT guardrail_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".guardrail_profile
    ADD CONSTRAINT guardrail_profile_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".guardrail_test_case
    ADD CONSTRAINT guardrail_test_case_guardrail_id_id_pk PRIMARY KEY (guardrail_id, id);

ALTER TABLE ONLY "public".validation_report_case
    ADD CONSTRAINT guardrail_validation_case_identity_idx UNIQUE (run_id, case_id);

ALTER TABLE ONLY "public".validation_report_case
    ADD CONSTRAINT guardrail_validation_case_pkey PRIMARY KEY (run_id, ordinal);

ALTER TABLE ONLY "public".validation_report_chunk
    ADD CONSTRAINT guardrail_validation_chunk_pkey PRIMARY KEY (run_id, sequence);

ALTER TABLE ONLY "public".guardrail_validation_run
    ADD CONSTRAINT guardrail_validation_run_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".guardrail_validation_snapshot
    ADD CONSTRAINT guardrail_validation_snapshot_pkey PRIMARY KEY (digest);

ALTER TABLE ONLY "public".validation_report_upload
    ADD CONSTRAINT guardrail_validation_upload_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY "public".guardrail_version
    ADD CONSTRAINT guardrail_version_guardrail_id_version_pk PRIMARY KEY (guardrail_id, version);

ALTER TABLE ONLY "public".guardrail_version_provenance
    ADD CONSTRAINT guardrail_version_provenance_pkey PRIMARY KEY (guardrail_id, version);

ALTER TABLE ONLY "public".model_assignment_validation
    ADD CONSTRAINT model_assignment_validation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".model_configuration_revision
    ADD CONSTRAINT model_configuration_revision_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".model_definition
    ADD CONSTRAINT model_definition_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".model_price_revision
    ADD CONSTRAINT model_price_revision_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".model_price_sync
    ADD CONSTRAINT model_price_sync_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".model_provider
    ADD CONSTRAINT model_provider_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".model_usage_cost
    ADD CONSTRAINT model_usage_cost_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".model_validation_credential_lease
    ADD CONSTRAINT model_validation_credential_lease_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".personal_access_token
    ADD CONSTRAINT personal_access_token_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".personal_access_token
    ADD CONSTRAINT personal_access_token_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY "public".playground_invocation
    ADD CONSTRAINT playground_invocation_pkey PRIMARY KEY (call_id);

ALTER TABLE ONLY "public".policy_imported_version
    ADD CONSTRAINT policy_imported_version_pkey PRIMARY KEY (policy_id, version);

ALTER TABLE ONLY "public".policy_record
    ADD CONSTRAINT policy_record_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".policy_resource
    ADD CONSTRAINT policy_resource_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".policy_resource_validation
    ADD CONSTRAINT policy_resource_validation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".policy_resource_version
    ADD CONSTRAINT policy_resource_version_pkey PRIMARY KEY (policy_id, version);

ALTER TABLE ONLY "public".policy_resource_version
    ADD CONSTRAINT policy_resource_version_policy_id_revision_key UNIQUE (policy_id, revision);

ALTER TABLE ONLY "public".policy_validation_run
    ADD CONSTRAINT policy_validation_run_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".policy_version
    ADD CONSTRAINT policy_version_policy_id_version_pk PRIMARY KEY (policy_id, version);

ALTER TABLE ONLY "public".project_group_model_configuration
    ADD CONSTRAINT project_group_model_configuration_id_key UNIQUE (id);

ALTER TABLE ONLY "public".project_group_model_configuration
    ADD CONSTRAINT project_group_model_configuration_pkey PRIMARY KEY (group_id);

ALTER TABLE ONLY "public".project_group
    ADD CONSTRAINT project_group_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".project_member
    ADD CONSTRAINT project_member_pkey PRIMARY KEY (project_id, user_id);

ALTER TABLE ONLY "public".project
    ADD CONSTRAINT project_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".resource_share
    ADD CONSTRAINT resource_share_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".route_assignment
    ADD CONSTRAINT route_assignment_pkey PRIMARY KEY (decision_id);

ALTER TABLE ONLY "public".runner_control_session
    ADD CONSTRAINT runner_control_session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".runner_instance
    ADD CONSTRAINT runner_instance_pkey PRIMARY KEY (runner_id);

ALTER TABLE ONLY "public".runner_pool_lease_epoch
    ADD CONSTRAINT runner_pool_lease_epoch_pkey PRIMARY KEY (pool_id);

ALTER TABLE ONLY "public".runner_pool
    ADD CONSTRAINT runner_pool_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".runner_serving_grant
    ADD CONSTRAINT runner_serving_grant_pkey PRIMARY KEY (pool_id, runner_id, boot_id, nonce);

ALTER TABLE ONLY "public".runner_telemetry_capability
    ADD CONSTRAINT runner_telemetry_capability_capability_hash_key UNIQUE (capability_hash);

ALTER TABLE ONLY "public".runner_telemetry_capability
    ADD CONSTRAINT runner_telemetry_capability_pkey PRIMARY KEY (control_session_id);

ALTER TABLE ONLY "public".runner_telemetry_wal
    ADD CONSTRAINT runner_telemetry_wal_pkey PRIMARY KEY (runner_id);

ALTER TABLE ONLY "public".runner_telemetry_wal
    ADD CONSTRAINT runner_telemetry_wal_wal_id_key UNIQUE (wal_id);

ALTER TABLE ONLY "public".runtime_event
    ADD CONSTRAINT runtime_event_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".telemetry_watermark
    ADD CONSTRAINT telemetry_watermark_pkey PRIMARY KEY (runner_id);

ALTER TABLE ONLY "public".traffic_router_change_request
    ADD CONSTRAINT traffic_router_change_request_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".traffic_router
    ADD CONSTRAINT traffic_router_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".traffic_router_revision
    ADD CONSTRAINT traffic_router_revision_pkey PRIMARY KEY (router_id, revision);

ALTER TABLE ONLY "public".traffic_router_revision
    ADD CONSTRAINT traffic_router_revision_router_id_idempotency_key_key UNIQUE (router_id, idempotency_key);

ALTER TABLE ONLY "public".validation_report_detail
    ADD CONSTRAINT validation_report_detail_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".validation_report
    ADD CONSTRAINT validation_report_guardrail_run_id_key UNIQUE (guardrail_run_id);

ALTER TABLE ONLY "public".validation_report
    ADD CONSTRAINT validation_report_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "public".validation_report
    ADD CONSTRAINT validation_report_policy_job_id_key UNIQUE (policy_job_id);

ALTER TABLE ONLY "public".validation_report
    ADD CONSTRAINT validation_report_policy_run_id_key UNIQUE (policy_run_id);

CREATE INDEX audit_project_time_idx ON "public".audit_event USING btree (project_id, occurred_at);

CREATE INDEX audit_resource_idx ON "public".audit_event USING btree (resource_type, resource_id);

CREATE INDEX audit_time_id_idx ON "public".audit_event USING btree (occurred_at DESC, id DESC);

CREATE UNIQUE INDEX auth_account_issuer_idx ON "public".auth_account USING btree (issuer, account_id);


CREATE INDEX auth_session_user_idx ON "public".auth_session USING btree (user_id);

CREATE UNIQUE INDEX auth_user_username_unique ON "public".auth_user USING btree (username);

CREATE INDEX auth_verification_identifier_idx ON "public".auth_verification USING btree (identifier);

CREATE INDEX controller_outbox_pending_idx ON "public".controller_outbox USING btree (processed_at, available_at);

CREATE INDEX runner_pool_group_idx ON "public".runner_pool USING btree (group_id, id);

CREATE INDEX project_group_idx ON "public".project USING btree (group_id, id);

CREATE INDEX auth_account_user_idx ON "public".auth_account USING btree (user_id, provider_id);

CREATE INDEX runner_instance_pool_idx ON "public".runner_instance USING btree (pool_id, runner_id);

CREATE INDEX project_member_user_idx ON "public".project_member USING btree (user_id, project_id);

CREATE INDEX endpoint_project_idx ON "public".endpoint USING btree (project_id);

CREATE INDEX endpoint_status_idx ON "public".endpoint USING btree (status);

CREATE UNIQUE INDEX endpoint_telemetry_context_active_endpoint_idx ON "public".endpoint_telemetry_context USING btree (pool_id, endpoint_id) WHERE (retired_at IS NULL);

CREATE INDEX endpoint_telemetry_context_pool_idx ON "public".endpoint_telemetry_context USING btree (pool_id, retired_at);

CREATE INDEX endpoint_telemetry_context_retention_idx ON "public".endpoint_telemetry_context USING btree (retired_at, id) WHERE (retired_at IS NOT NULL);

CREATE INDEX endpoint_traffic_router_idx ON "public".endpoint USING btree (traffic_router_id);

CREATE UNIQUE INDEX guardrail_artifact_checksum_idx ON "public".guardrail_artifact USING btree (checksum);

CREATE INDEX guardrail_artifact_version_idx ON "public".guardrail_artifact USING btree (guardrail_id, guardrail_version);

CREATE UNIQUE INDEX guardrail_profile_category_default_idx ON "public".guardrail_profile USING btree (category) WHERE (is_default AND enabled);

CREATE INDEX guardrail_project_idx ON "public".guardrail USING btree (project_id);

CREATE INDEX guardrail_status_idx ON "public".guardrail USING btree (status);

CREATE INDEX guardrail_test_case_guardrail_idx ON "public".guardrail_test_case USING btree (guardrail_id);

CREATE INDEX guardrail_validation_case_page_idx ON "public".validation_report_case USING btree (run_id, priority, ordinal);

CREATE INDEX guardrail_validation_case_status_idx ON "public".validation_report_case USING btree (run_id, status, priority, ordinal);

CREATE INDEX guardrail_validation_retention_idx ON "public".guardrail_validation_run USING btree (guardrail_id, status, COALESCE(completed_at, created_at) DESC, id DESC);

CREATE INDEX guardrail_validation_run_guardrail_idx ON "public".guardrail_validation_run USING btree (guardrail_id, created_at);

CREATE INDEX guardrail_validation_snapshot_digest_idx ON "public".guardrail_validation_run USING btree (snapshot_digest);

CREATE UNIQUE INDEX guardrail_version_generation_idx ON "public".guardrail_version USING btree (generation);

CREATE INDEX model_assignment_validation_lookup_idx ON "public".model_assignment_validation USING btree (actor_id, target, model_id, created_at);

CREATE UNIQUE INDEX model_configuration_revision_platform_number_idx ON "public".model_configuration_revision USING btree (revision) WHERE (project_id IS NULL);

CREATE UNIQUE INDEX model_configuration_revision_project_number_idx ON "public".model_configuration_revision USING btree (project_id, revision);

CREATE INDEX model_configuration_revision_state_idx ON "public".model_configuration_revision USING btree (state);

CREATE UNIQUE INDEX model_definition_platform_provider_model_idx ON "public".model_definition USING btree (provider_id, model, profile) WHERE (project_id IS NULL);

CREATE INDEX model_definition_project_idx ON "public".model_definition USING btree (project_id);

CREATE UNIQUE INDEX model_definition_project_provider_model_idx ON "public".model_definition USING btree (project_id, provider_id, model, profile);

CREATE INDEX model_definition_provider_idx ON "public".model_definition USING btree (provider_id);

CREATE INDEX model_definition_status_idx ON "public".model_definition USING btree (status);

CREATE INDEX model_price_revision_lookup_idx ON "public".model_price_revision USING btree (key, effective_at DESC);

CREATE UNIQUE INDEX model_provider_name_idx ON "public".model_provider USING btree (name);

CREATE INDEX model_provider_status_idx ON "public".model_provider USING btree (status);

CREATE INDEX model_usage_cost_allocation_context_idx ON "public".model_usage_cost USING btree (allocation_context_id);

CREATE INDEX model_usage_cost_event_idx ON "public".model_usage_cost USING btree (event_id);

CREATE INDEX model_usage_cost_guardrail_time_idx ON "public".model_usage_cost USING btree (guardrail_id, occurred_at);

CREATE INDEX model_validation_credential_lease_expiry_idx ON "public".model_validation_credential_lease USING btree (expires_at);

CREATE INDEX personal_access_token_user_idx ON "public".personal_access_token USING btree (user_id);

CREATE INDEX playground_invocation_expiry_idx ON "public".playground_invocation USING btree (expires_at);

CREATE INDEX policy_record_name_idx ON "public".policy_record USING btree (name);

CREATE INDEX policy_record_project_idx ON "public".policy_record USING btree (project_id);

CREATE INDEX policy_resource_validation_parent_idx ON "public".policy_resource_validation USING btree (parent_id);

CREATE INDEX policy_resource_validation_policy_idx ON "public".policy_resource_validation USING btree (policy_id, created_at);

CREATE INDEX policy_validation_run_policy_idx ON "public".policy_validation_run USING btree (policy_id, created_at);

CREATE UNIQUE INDEX policy_version_checksum_idx ON "public".policy_version USING btree (checksum);

CREATE UNIQUE INDEX policy_version_source_draft_idx ON "public".policy_version USING btree (policy_id, source_draft_revision);


CREATE UNIQUE INDEX project_group_single_default_idx ON "public".project_group USING btree (is_default) WHERE (is_default = true);


CREATE UNIQUE INDEX project_name_idx ON "public".project USING btree (name);

CREATE INDEX resource_share_owner_idx ON "public".resource_share USING btree (owner_project_id, resource_type, resource_id);

CREATE UNIQUE INDEX resource_share_unique_idx ON "public".resource_share USING btree (owner_project_id, recipient_project_id, resource_type, resource_id);

CREATE INDEX route_assignment_allocation_context_idx ON "public".route_assignment USING btree (allocation_context_id);

CREATE INDEX route_assignment_guardrail_idx ON "public".route_assignment USING btree (guardrail_id);

CREATE INDEX route_assignment_project_router_time_idx ON "public".route_assignment USING btree (project_id, router_id, occurred_at);

CREATE INDEX route_assignment_router_time_idx ON "public".route_assignment USING btree (router_id, occurred_at);

CREATE INDEX runner_control_session_runner_idx ON "public".runner_control_session USING btree (runner_id, boot_id);



CREATE UNIQUE INDEX runner_pool_project_idx ON "public".runner_pool USING btree (project_id);

CREATE UNIQUE INDEX runner_pool_single_default_idx ON "public".runner_pool USING btree (is_default) WHERE (is_default = true);

CREATE INDEX runner_serving_grant_expiry_idx ON "public".runner_serving_grant USING btree (pool_id, epoch, conservative_expires_at);

CREATE INDEX runtime_event_allocation_context_idx ON "public".runtime_event USING btree (allocation_context_id);

CREATE INDEX runtime_event_endpoint_direction_time_idx ON "public".runtime_event USING btree (endpoint_id, direction, occurred_at);

CREATE INDEX runtime_event_endpoint_error_time_idx ON "public".runtime_event USING btree (endpoint_id, occurred_at) WHERE (lower(decision) = ANY (ARRAY['error'::text, 'failed'::text, 'failure'::text, 'timeout'::text, 'timed_out'::text]));

CREATE INDEX runtime_event_endpoint_final_time_idx ON "public".runtime_event USING btree (endpoint_id, occurred_at) WHERE ((metadata ->> 'streamFinalCheck'::text) = 'true'::text);

CREATE INDEX runtime_event_endpoint_time_idx ON "public".runtime_event USING btree (endpoint_id, occurred_at);

CREATE INDEX runtime_event_guardrail_time_id_idx ON "public".runtime_event USING btree (guardrail_id, occurred_at, id);

CREATE INDEX runtime_event_project_time_idx ON "public".runtime_event USING btree (project_id, occurred_at);

CREATE INDEX runtime_event_request_time_idx ON "public".runtime_event USING btree (request_id, occurred_at, id);

CREATE INDEX runtime_event_router_time_idx ON "public".runtime_event USING btree (router_id, occurred_at, id);

CREATE INDEX runtime_event_time_id_idx ON "public".runtime_event USING btree (occurred_at, id);

CREATE UNIQUE INDEX traffic_router_change_request_pending_idx ON "public".traffic_router_change_request USING btree (router_id) WHERE (status = 'pending'::text);

CREATE INDEX traffic_router_change_request_router_idx ON "public".traffic_router_change_request USING btree (router_id, submitted_at);

CREATE INDEX traffic_router_project_idx ON "public".traffic_router USING btree (project_id);

CREATE INDEX validation_report_case_detail_idx ON "public".validation_report_case USING btree (detail_id);

CREATE INDEX validation_report_detail_owner_idx ON "public".validation_report_detail USING btree (owner_id);

CREATE TRIGGER audit_event_project_from_actor BEFORE INSERT ON "public".audit_event FOR EACH ROW EXECUTE FUNCTION "public".set_audit_event_project();

CREATE TRIGGER endpoint_telemetry_context_immutable BEFORE DELETE OR UPDATE ON "public".endpoint_telemetry_context FOR EACH ROW EXECUTE FUNCTION "public".protect_endpoint_telemetry_context();

CREATE TRIGGER group_model_configuration_replacement BEFORE DELETE OR UPDATE ON "public".project_group_model_configuration FOR EACH ROW EXECUTE FUNCTION "public".protect_group_model_configuration();

CREATE TRIGGER project_name_immutable BEFORE UPDATE OF name ON "public".project FOR EACH ROW EXECUTE FUNCTION "public".protect_project_name();

CREATE TRIGGER register_report AFTER INSERT ON "public".guardrail_validation_run FOR EACH ROW EXECUTE FUNCTION "public".register_validation_report();

CREATE TRIGGER register_report AFTER INSERT ON "public".policy_resource_validation FOR EACH ROW EXECUTE FUNCTION "public".register_validation_report();

CREATE TRIGGER register_report AFTER INSERT ON "public".policy_validation_run FOR EACH ROW EXECUTE FUNCTION "public".register_validation_report();

ALTER TABLE ONLY "public".audit_event
    ADD CONSTRAINT audit_event_actor_id_auth_user_id_fk FOREIGN KEY (actor_id) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".audit_event
    ADD CONSTRAINT audit_event_project_id_fkey FOREIGN KEY (project_id) REFERENCES "public".project(id);

ALTER TABLE ONLY "public".auth_account
    ADD CONSTRAINT auth_account_user_id_auth_user_id_fk FOREIGN KEY (user_id) REFERENCES "public".auth_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".auth_session
    ADD CONSTRAINT auth_session_active_project_id_fkey FOREIGN KEY (active_project_id) REFERENCES "public".project(id);

ALTER TABLE ONLY "public".auth_session
    ADD CONSTRAINT auth_session_user_id_auth_user_id_fk FOREIGN KEY (user_id) REFERENCES "public".auth_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".endpoint
    ADD CONSTRAINT endpoint_deleted_by_auth_user_id_fk FOREIGN KEY (deleted_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".endpoint
    ADD CONSTRAINT endpoint_project_id_fkey FOREIGN KEY (project_id) REFERENCES "public".project(id);

ALTER TABLE ONLY "public".endpoint
    ADD CONSTRAINT endpoint_traffic_router_id_fkey FOREIGN KEY (traffic_router_id) REFERENCES "public".traffic_router(id);

ALTER TABLE ONLY "public".guardrail_artifact
    ADD CONSTRAINT guardrail_artifact_guardrail_id_guardrail_id_fk FOREIGN KEY (guardrail_id) REFERENCES "public".guardrail(id);

ALTER TABLE ONLY "public".guardrail
    ADD CONSTRAINT guardrail_deleted_by_auth_user_id_fk FOREIGN KEY (deleted_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".guardrail_package
    ADD CONSTRAINT guardrail_package_project_id_fkey FOREIGN KEY (project_id) REFERENCES "public".project(id);

ALTER TABLE ONLY "public".guardrail_package
    ADD CONSTRAINT guardrail_package_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".guardrail
    ADD CONSTRAINT guardrail_protection_mode_updated_by_fkey FOREIGN KEY (protection_mode_updated_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".guardrail
    ADD CONSTRAINT guardrail_project_id_fkey FOREIGN KEY (project_id) REFERENCES "public".project(id);

ALTER TABLE ONLY "public".guardrail_test_case
    ADD CONSTRAINT guardrail_test_case_guardrail_id_guardrail_id_fk FOREIGN KEY (guardrail_id) REFERENCES "public".guardrail(id);

ALTER TABLE ONLY "public".validation_report_chunk
    ADD CONSTRAINT guardrail_validation_chunk_run_id_fkey FOREIGN KEY (run_id) REFERENCES "public".validation_report_upload(run_id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".guardrail_validation_run
    ADD CONSTRAINT guardrail_validation_run_created_by_auth_user_id_fk FOREIGN KEY (created_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".guardrail_validation_run
    ADD CONSTRAINT guardrail_validation_run_guardrail_id_guardrail_id_fk FOREIGN KEY (guardrail_id) REFERENCES "public".guardrail(id);

ALTER TABLE ONLY "public".guardrail_validation_run
    ADD CONSTRAINT guardrail_validation_snapshot_ref FOREIGN KEY (snapshot_digest) REFERENCES "public".guardrail_validation_snapshot(digest);

ALTER TABLE ONLY "public".guardrail_version
    ADD CONSTRAINT guardrail_version_created_by_auth_user_id_fk FOREIGN KEY (created_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".guardrail_version
    ADD CONSTRAINT guardrail_version_guardrail_id_guardrail_id_fk FOREIGN KEY (guardrail_id) REFERENCES "public".guardrail(id);

ALTER TABLE ONLY "public".guardrail_version_provenance
    ADD CONSTRAINT guardrail_version_provenance_guardrail_id_version_fkey FOREIGN KEY (guardrail_id, version) REFERENCES "public".guardrail_version(guardrail_id, version) ON DELETE CASCADE;

ALTER TABLE ONLY "public".guardrail_version_provenance
    ADD CONSTRAINT guardrail_version_provenance_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".guardrail_version_provenance
    ADD CONSTRAINT guardrail_version_provenance_package_id_fkey FOREIGN KEY (package_id) REFERENCES "public".guardrail_package(id);

ALTER TABLE ONLY "public".guardrail_version
    ADD CONSTRAINT guardrail_version_released_by_fkey FOREIGN KEY (released_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".model_assignment_validation
    ADD CONSTRAINT model_assignment_validation_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES "public".auth_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".model_assignment_validation
    ADD CONSTRAINT model_assignment_validation_model_id_fkey FOREIGN KEY (model_id) REFERENCES "public".model_definition(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".model_configuration_revision
    ADD CONSTRAINT model_configuration_revision_created_by_auth_user_id_fk FOREIGN KEY (created_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".model_configuration_revision
    ADD CONSTRAINT model_configuration_revision_project_id_fkey FOREIGN KEY (project_id) REFERENCES "public".project(id);

ALTER TABLE ONLY "public".model_definition
    ADD CONSTRAINT model_definition_created_by_auth_user_id_fk FOREIGN KEY (created_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".model_definition
    ADD CONSTRAINT model_definition_provider_id_model_provider_id_fk FOREIGN KEY (provider_id) REFERENCES "public".model_provider(id) ON DELETE RESTRICT;

ALTER TABLE ONLY "public".model_definition
    ADD CONSTRAINT model_definition_project_id_fkey FOREIGN KEY (project_id) REFERENCES "public".project(id);

ALTER TABLE ONLY "public".model_provider
    ADD CONSTRAINT model_provider_created_by_auth_user_id_fk FOREIGN KEY (created_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".model_usage_cost
    ADD CONSTRAINT model_usage_cost_project_id_fkey FOREIGN KEY (project_id) REFERENCES "public".project(id);

ALTER TABLE ONLY "public".model_validation_credential_lease
    ADD CONSTRAINT model_validation_credential_lease_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES "public".model_provider(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".personal_access_token
    ADD CONSTRAINT personal_access_token_project_id_fkey FOREIGN KEY (project_id) REFERENCES "public".project(id);

ALTER TABLE ONLY "public".personal_access_token
    ADD CONSTRAINT personal_access_token_user_id_fkey FOREIGN KEY (user_id) REFERENCES "public".auth_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".playground_invocation
    ADD CONSTRAINT playground_invocation_project_id_fkey FOREIGN KEY (project_id) REFERENCES "public".project(id);

ALTER TABLE ONLY "public".policy_imported_version
    ADD CONSTRAINT policy_imported_version_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".policy_imported_version
    ADD CONSTRAINT policy_imported_version_package_id_fkey FOREIGN KEY (package_id) REFERENCES "public".guardrail_package(id) ON DELETE SET NULL;

ALTER TABLE ONLY "public".policy_imported_version
    ADD CONSTRAINT policy_imported_version_project_id_fkey FOREIGN KEY (project_id) REFERENCES "public".project(id);

ALTER TABLE ONLY "public".policy_record
    ADD CONSTRAINT policy_record_project_id_fkey FOREIGN KEY (project_id) REFERENCES "public".project(id);

ALTER TABLE ONLY "public".policy_resource
    ADD CONSTRAINT policy_resource_project_id_fkey FOREIGN KEY (project_id) REFERENCES "public".project(id);

ALTER TABLE ONLY "public".policy_resource_validation
    ADD CONSTRAINT policy_resource_validation_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES "public".policy_resource(id);

ALTER TABLE ONLY "public".policy_resource_version
    ADD CONSTRAINT policy_resource_version_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES "public".policy_resource(id);

ALTER TABLE ONLY "public".policy_validation_run
    ADD CONSTRAINT policy_validation_run_created_by_auth_user_id_fk FOREIGN KEY (created_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".policy_validation_run
    ADD CONSTRAINT policy_validation_run_policy_id_policy_record_id_fk FOREIGN KEY (policy_id) REFERENCES "public".policy_record(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".policy_version
    ADD CONSTRAINT policy_version_policy_id_policy_record_id_fk FOREIGN KEY (policy_id) REFERENCES "public".policy_record(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".project_member
    ADD CONSTRAINT project_member_project_id_fkey FOREIGN KEY (project_id) REFERENCES "public".project(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".project_member
    ADD CONSTRAINT project_member_user_id_fkey FOREIGN KEY (user_id) REFERENCES "public".auth_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".resource_share
    ADD CONSTRAINT resource_share_created_by_fkey FOREIGN KEY (created_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".resource_share
    ADD CONSTRAINT resource_share_owner_project_id_fkey FOREIGN KEY (owner_project_id) REFERENCES "public".project(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".resource_share
    ADD CONSTRAINT resource_share_recipient_project_id_fkey FOREIGN KEY (recipient_project_id) REFERENCES "public".project(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".route_assignment
    ADD CONSTRAINT route_assignment_project_id_fkey FOREIGN KEY (project_id) REFERENCES "public".project(id);

ALTER TABLE ONLY "public".runner_control_session
    ADD CONSTRAINT runner_control_session_pool_id_fkey FOREIGN KEY (pool_id) REFERENCES "public".runner_pool(id);

ALTER TABLE ONLY "public".runner_instance
    ADD CONSTRAINT runner_instance_control_session_id_fkey FOREIGN KEY (control_session_id) REFERENCES "public".runner_control_session(id);

ALTER TABLE ONLY "public".runner_instance
    ADD CONSTRAINT runner_instance_pool_id_runner_pool_id_fk FOREIGN KEY (pool_id) REFERENCES "public".runner_pool(id);

ALTER TABLE ONLY "public".runner_pool
    ADD CONSTRAINT runner_pool_group_id_fkey FOREIGN KEY (group_id) REFERENCES "public".project_group(id);

ALTER TABLE ONLY "public".runner_pool_lease_epoch
    ADD CONSTRAINT runner_pool_lease_epoch_pool_id_fkey FOREIGN KEY (pool_id) REFERENCES "public".runner_pool(id);

ALTER TABLE ONLY "public".runner_pool
    ADD CONSTRAINT runner_pool_project_id_fkey FOREIGN KEY (project_id) REFERENCES "public".project(id);

ALTER TABLE ONLY "public".runner_serving_grant
    ADD CONSTRAINT runner_serving_grant_control_session_id_fkey FOREIGN KEY (control_session_id) REFERENCES "public".runner_control_session(id);

ALTER TABLE ONLY "public".runner_serving_grant
    ADD CONSTRAINT runner_serving_grant_pool_id_fkey FOREIGN KEY (pool_id) REFERENCES "public".runner_pool_lease_epoch(pool_id);

ALTER TABLE ONLY "public".runner_telemetry_capability
    ADD CONSTRAINT runner_telemetry_capability_control_session_id_fkey FOREIGN KEY (control_session_id) REFERENCES "public".runner_control_session(id);

ALTER TABLE ONLY "public".runner_telemetry_capability
    ADD CONSTRAINT runner_telemetry_capability_wal_id_fkey FOREIGN KEY (wal_id) REFERENCES "public".runner_telemetry_wal(wal_id);

ALTER TABLE ONLY "public".runner_telemetry_wal
    ADD CONSTRAINT runner_telemetry_wal_pool_id_fkey FOREIGN KEY (pool_id) REFERENCES "public".runner_pool(id);

ALTER TABLE ONLY "public".runtime_event
    ADD CONSTRAINT runtime_event_project_id_fkey FOREIGN KEY (project_id) REFERENCES "public".project(id);

ALTER TABLE ONLY "public".project
    ADD CONSTRAINT project_group_id_fkey FOREIGN KEY (group_id) REFERENCES "public".project_group(id);

ALTER TABLE ONLY "public".project_group_model_configuration
    ADD CONSTRAINT project_group_model_configuration_group_id_fkey FOREIGN KEY (group_id) REFERENCES "public".project_group(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".project_group_model_configuration
    ADD CONSTRAINT project_group_model_configuration_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".traffic_router_change_request
    ADD CONSTRAINT traffic_router_change_request_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".traffic_router_change_request
    ADD CONSTRAINT traffic_router_change_request_reverts_change_request_id_fkey FOREIGN KEY (reverts_change_request_id) REFERENCES "public".traffic_router_change_request(id);

ALTER TABLE ONLY "public".traffic_router_change_request
    ADD CONSTRAINT traffic_router_change_request_router_id_fkey FOREIGN KEY (router_id) REFERENCES "public".traffic_router(id);

ALTER TABLE ONLY "public".traffic_router_change_request
    ADD CONSTRAINT traffic_router_change_request_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".traffic_router_revision
    ADD CONSTRAINT traffic_router_revision_change_request_id_fkey FOREIGN KEY (change_request_id) REFERENCES "public".traffic_router_change_request(id);

ALTER TABLE ONLY "public".traffic_router_revision
    ADD CONSTRAINT traffic_router_revision_created_by_fkey FOREIGN KEY (created_by) REFERENCES "public".auth_user(id);

ALTER TABLE ONLY "public".traffic_router_revision
    ADD CONSTRAINT traffic_router_revision_router_id_fkey FOREIGN KEY (router_id) REFERENCES "public".traffic_router(id);

ALTER TABLE ONLY "public".traffic_router
    ADD CONSTRAINT traffic_router_project_id_fkey FOREIGN KEY (project_id) REFERENCES "public".project(id);

ALTER TABLE ONLY "public".validation_report_case
    ADD CONSTRAINT validation_report_case_detail_id_fkey FOREIGN KEY (detail_id) REFERENCES "public".validation_report_detail(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".validation_report_case
    ADD CONSTRAINT validation_report_case_run_id_fkey FOREIGN KEY (run_id) REFERENCES "public".validation_report(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".validation_report_detail
    ADD CONSTRAINT validation_report_detail_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES "public".validation_report(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".validation_report
    ADD CONSTRAINT validation_report_guardrail_run_id_fkey FOREIGN KEY (guardrail_run_id) REFERENCES "public".guardrail_validation_run(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".validation_report
    ADD CONSTRAINT validation_report_policy_job_id_fkey FOREIGN KEY (policy_job_id) REFERENCES "public".policy_resource_validation(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".validation_report
    ADD CONSTRAINT validation_report_policy_run_id_fkey FOREIGN KEY (policy_run_id) REFERENCES "public".policy_validation_run(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public".validation_report_upload
    ADD CONSTRAINT validation_report_upload_run_id_fkey FOREIGN KEY (run_id) REFERENCES "public".validation_report(id) ON DELETE CASCADE;

INSERT INTO project_group(id,name,is_default) VALUES ('default','Default group',true);
