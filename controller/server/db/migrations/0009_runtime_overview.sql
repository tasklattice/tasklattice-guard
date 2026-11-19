-- Recreate deployments already stop the old Controller during migrations.
-- Serialize the one-time backfill with writers; readers can continue.
LOCK TABLE runtime_event IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE runtime_overview_bucket (
  project_id text NOT NULL, guardrail_id text NOT NULL, router_id text NOT NULL, endpoint_id text NOT NULL,
  resolution integer NOT NULL, bucket_start timestamptz NOT NULL,
  counts jsonb NOT NULL, histogram jsonb NOT NULL,
  PRIMARY KEY(project_id, resolution, bucket_start, guardrail_id, router_id, endpoint_id)
);
CREATE INDEX runtime_overview_time_idx ON runtime_overview_bucket(resolution, bucket_start);

CREATE FUNCTION runtime_add_counts(a jsonb, b jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) FROM (
    SELECT key, sum(value::bigint)::bigint AS value
    FROM (SELECT * FROM jsonb_each_text(a) UNION ALL SELECT * FROM jsonb_each_text(b)) pairs
    GROUP BY key
  ) summed
$fn$;

-- Batch projection, including signed corrections/deletes. Histogram buckets
-- have <=5% relative width (plus integer-ms rounding); counts remain exact.
CREATE FUNCTION runtime_overview_sql(source_query text) RETURNS text
LANGUAGE plpgsql AS $fn$
BEGIN
  RETURN format($query$
    WITH source AS (%s), facts AS MATERIALIZED (
      SELECT project_id,guardrail_id,router_id,endpoint_id,occurred_at,duration_ms,weight,
        metadata->>'executionStatus' = 'timeout' AS timed_out,
        metadata->>'captureLevel' IS NOT NULL AS has_evidence,
        metadata#>>'{usage,fail_closed}' = 'true' AS fail_closed,
        CASE WHEN coalesce(metadata->>'executionStatus' IN ('error','timeout'),false)
        THEN 'error' ELSE decision END AS outcome,
        CASE WHEN duration_ms <= 0 THEN 0 ELSE least(
          ceil(power(1.05,ceil(ln(duration_ms::numeric)/ln(1.05))))::bigint,
          CASE WHEN duration_ms <= 2500 THEN 2500 WHEN duration_ms <= 5000 THEN 5000 ELSE 2147483647 END
        ) END AS latency_bin
      FROM source
    ), bins AS (
      SELECT coalesce(project_id,'') AS project_id, coalesce(guardrail_id,'') AS guardrail_id,
        coalesce(router_id,'') AS router_id, coalesce(endpoint_id,'') AS endpoint_id,
        resolution, date_bin(make_interval(secs => resolution), occurred_at, '2000-01-01 00:00:00+00'::timestamptz) AS bucket_start,
        latency_bin, sum(CASE WHEN true THEN weight ELSE 0 END)::bigint AS total,
        sum(CASE WHEN outcome = 'allow' THEN weight ELSE 0 END)::bigint AS allowed,
        sum(CASE WHEN outcome = 'block' THEN weight ELSE 0 END)::bigint AS blocked,
        sum(CASE WHEN outcome = 'transform' THEN weight ELSE 0 END)::bigint AS intervened,
        sum(CASE WHEN outcome = 'error' THEN weight ELSE 0 END)::bigint AS errors,
        sum(CASE WHEN timed_out THEN weight ELSE 0 END)::bigint AS timeout_count,
        sum(CASE WHEN has_evidence THEN weight ELSE 0 END)::bigint AS evidence,
        sum(CASE WHEN fail_closed THEN weight ELSE 0 END)::bigint AS fail_closed_count,
        sum(CASE WHEN duration_ms > 2500 THEN weight ELSE 0 END)::bigint AS slo_breach_count,
        sum(CASE WHEN router_id IS NULL THEN weight ELSE 0 END)::bigint AS unassigned
      FROM facts CROSS JOIN (VALUES (60),(900),(3600)) resolutions(resolution)
      GROUP BY 1,2,3,4,5,6,7
    )
    INSERT INTO runtime_overview_bucket AS target
      (project_id,guardrail_id,router_id,endpoint_id,resolution,bucket_start,counts,histogram)
    SELECT project_id,guardrail_id,router_id,endpoint_id,resolution,bucket_start,
      jsonb_build_object('total', sum(total), 'allowed', sum(allowed), 'blocked', sum(blocked), 'intervened', sum(intervened), 'errors', sum(errors), 'timeout_count', sum(timeout_count), 'evidence', sum(evidence), 'fail_closed_count', sum(fail_closed_count), 'slo_breach_count', sum(slo_breach_count), 'unassigned', sum(unassigned)),
      jsonb_object_agg(latency_bin::text,total)
    FROM bins GROUP BY 1,2,3,4,5,6
    ORDER BY 1,5,6,2,3,4
    ON CONFLICT (project_id,resolution,bucket_start,guardrail_id,router_id,endpoint_id)
    DO UPDATE SET counts=runtime_add_counts(target.counts,excluded.counts),
      histogram=runtime_add_counts(target.histogram,excluded.histogram)
  $query$, source_query);
END
$fn$;

DO $backfill$ BEGIN
  EXECUTE runtime_overview_sql('SELECT *, 1::bigint AS weight FROM runtime_event');
END $backfill$;

CREATE FUNCTION runtime_overview_after_write() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    EXECUTE runtime_overview_sql('SELECT *, 1::bigint AS weight FROM new_runtime_events');
  ELSIF TG_OP = 'DELETE' THEN
    EXECUTE runtime_overview_sql('SELECT *, -1::bigint AS weight FROM old_runtime_events');
  ELSE
    -- Body enrichment does not change counts. Do not touch hot aggregate rows
    -- or decompress captured bodies when the metric facts are unchanged.
    EXECUTE runtime_overview_sql($source$
      WITH changed AS (
        SELECT n.id FROM new_runtime_events n JOIN old_runtime_events o USING(id)
        WHERE ROW(n.project_id,n.guardrail_id,n.router_id,n.endpoint_id,n.occurred_at,n.decision,n.duration_ms,
          n.metadata->>'executionStatus',n.metadata->>'captureLevel',n.metadata#>>'{usage,fail_closed}')
        IS DISTINCT FROM ROW(o.project_id,o.guardrail_id,o.router_id,o.endpoint_id,o.occurred_at,o.decision,o.duration_ms,
          o.metadata->>'executionStatus',o.metadata->>'captureLevel',o.metadata#>>'{usage,fail_closed}')
      )
      SELECT n.*,1::bigint AS weight FROM new_runtime_events n JOIN changed USING(id)
      UNION ALL SELECT o.*,-1::bigint AS weight FROM old_runtime_events o JOIN changed USING(id)
    $source$);
  END IF;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER runtime_overview_insert AFTER INSERT ON runtime_event
  REFERENCING NEW TABLE AS new_runtime_events FOR EACH STATEMENT EXECUTE FUNCTION runtime_overview_after_write();
CREATE TRIGGER runtime_overview_update AFTER UPDATE ON runtime_event
  REFERENCING OLD TABLE AS old_runtime_events NEW TABLE AS new_runtime_events FOR EACH STATEMENT EXECUTE FUNCTION runtime_overview_after_write();
CREATE TRIGGER runtime_overview_delete AFTER DELETE ON runtime_event
  REFERENCING OLD TABLE AS old_runtime_events FOR EACH STATEMENT EXECUTE FUNCTION runtime_overview_after_write();
