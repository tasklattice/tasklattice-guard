import { sql } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";

export const metricWindows = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "15d": 1_296_000_000, "30d": 2_592_000_000 };
export type MetricScope = { window: keyof typeof metricWindows; guardrailId?: string | undefined; deploymentId?: string | undefined };
// Rows contain aggregate values only. Protected content and individual traces never leave PostgreSQL.
type Row = Record<string, any>;
const pct = (n: number, d: number) => d ? Math.round(n / d * 10_000) / 100 : 0;
const delta = (n: number, d: number) => d ? Math.round((n - d) / d * 10_000) / 100 : n ? null : 0;
const quantile = (a: number[], q: number) => a.length ? [...a].sort((a, b) => a - b)[Math.ceil(a.length * q) - 1] ?? 0 : 0;
const numeric = (field: string) => sql.raw(`CASE WHEN jsonb_typeof(usage->'${field}') = 'number' THEN (usage->>'${field}')::double precision END`);
const usageTotals = ["rail_invocations", "action_invocations", "model_invocations", "cache_hits", "cache_misses"];

export async function queryRuntimeMetrics(db: ControllerDatabase, scope: MetricScope) {
  const now = Date.now(), duration = metricWindows[scope.window], start = now - duration;
  const interval = ({ "1h": "1m", "24h": "15m", "7d": "1h", "15d": "6h", "30d": "1d" } as const)[scope.window];
  const step = ({ "1m": 60_000, "15m": 900_000, "1h": 3_600_000, "6h": 21_600_000, "1d": 86_400_000 })[interval];
  const predicate = sql`occurred_at >= ${new Date(start - duration).toISOString()}::timestamptz AND occurred_at <= ${new Date(now).toISOString()}::timestamptz
    ${scope.guardrailId ? sql`AND guardrail_id = ${scope.guardrailId}` : sql``}
    ${scope.deploymentId ? sql`AND deployment_id = ${scope.deploymentId}` : sql``}`;
  return db.transaction(async tx => {
    // Bound database resources and fail visibly instead of blocking the control plane indefinitely.
    await tx.execute(sql`SET LOCAL statement_timeout = '20s'`);
    await tx.execute(sql`SET LOCAL work_mem = '16MB'`);
    await tx.execute(sql`SET LOCAL jit = off`);
    const totals = await tx.execute(sql`
      WITH base AS MATERIALIZED (
        SELECT occurred_at,guardrail_id,guardrail_version,integration_id,deployment_id,duration_ms,
          occurred_at >= ${new Date(start).toISOString()}::timestamptz AS current,
          lower(decision) IN ('timeout','timed_out') OR metadata->>'timedOut'='true' OR metadata->>'timed_out'='true' AS timed_out,
          metadata->>'captureLevel' IS NOT NULL AS has_evidence,
          metadata->>'protocol' AS protocol,metadata->>'runtimeEngine' AS engine,metadata->>'configChecksum' AS checksum,
          metadata->'usage' AS usage,
          CASE WHEN lower(decision) IN ('allow','allowed','pass','passed') THEN 'allow'
            WHEN lower(decision) IN ('transform','transformed','redact','redacted','rewrite','rewritten','intervene','intervened') THEN 'transform'
            WHEN lower(decision) IN ('block','blocked','reject','rejected','deny','denied') THEN 'block'
            WHEN lower(decision) IN ('error','failed','failure','timeout','timed_out') THEN 'error' ELSE decision END AS outcome
        FROM runtime_event WHERE ${predicate}
      ), groups AS (
        SELECT base.*, g.kind, g.key FROM base CROSS JOIN LATERAL (
          SELECT 'period' AS kind, CASE WHEN current THEN 'current' ELSE 'previous' END AS key
          UNION ALL SELECT 'guardrail', coalesce(guardrail_id,'') WHERE current
          UNION ALL SELECT 'caller', jsonb_build_array(integration_id,deployment_id)::text WHERE current
          UNION ALL SELECT 'version', jsonb_build_array(guardrail_id,guardrail_version)::text WHERE current
          UNION ALL SELECT 'engine', coalesce(usage->>'runtime_engine',engine,'unknown') WHERE current
          UNION ALL SELECT 'trend', (floor(extract(epoch from occurred_at)*1000/${step})*${step})::bigint::text WHERE current
          UNION ALL SELECT 'guardrail-trend', jsonb_build_array(guardrail_id,(floor(extract(epoch from occurred_at)*1000/${step})*${step})::bigint)::text WHERE current
        ) g
      ) SELECT kind, key, count(*)::int AS total,
        count(*) FILTER (WHERE outcome='allow')::int AS allowed,
        count(*) FILTER (WHERE outcome='block')::int AS blocked,
        count(*) FILTER (WHERE outcome='transform')::int AS intervened,
        count(*) FILTER (WHERE outcome='error')::int AS errors,
        count(*) FILTER (WHERE timed_out)::int AS timeout_count,
        count(*) FILTER (WHERE has_evidence)::int AS evidence,
        count(*) FILTER (WHERE usage->>'fail_closed'='true')::int AS fail_closed_count,
        count(*) FILTER (WHERE duration_ms > 2500)::int AS slo_breach_count,
        count(*) FILTER (WHERE deployment_id IS NULL)::int AS unassigned,
        count(DISTINCT integration_id) FILTER (WHERE outcome='error')::int AS degraded_integrations,
        percentile_disc(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY duration_ms) AS latency,
        percentile_disc(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY ${numeric("queue_latency_ms")}) AS queue,
        percentile_disc(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY ${numeric("provider_latency_ms")}) AS provider,
        coalesce(max(${numeric("active_concurrency")}),0) AS peak_active_concurrency,
        ${sql.join(usageTotals.map(key => sql`coalesce(sum(${numeric(key)}),0) AS ${sql.identifier(key)}`), sql`,`)},
        array_agg(DISTINCT coalesce(usage->>'runtime_engine',engine,'unknown')) AS runtime_engines,
        array_remove(array_agg(DISTINCT coalesce(usage->>'config_checksum',checksum)),NULL) AS config_checksums,
        array_remove(array_agg(DISTINCT guardrail_version),NULL) AS versions,
        min(protocol) AS protocol
      FROM groups GROUP BY kind,key`);
    const components = await tx.execute(sql`
      WITH steps AS MATERIALIZED (
        SELECT guardrail_id, s->>'kind' AS step_kind,
          coalesce(s->>'name',s->>'actionName',s->>'flowName','runtime-step') AS name,
          s->>'risk' AS risk,s->>'policyId' AS policy_id,s->>'policyVersion' AS policy_version,
          s->>'railType' AS rail_type,s->>'flowName' AS flow_name,s->>'actionName' AS action_name,
          s->>'actionVersion' AS action_version,s->>'parallelGroup' AS parallel_group,
          coalesce(s->>'outcome',s->>'status',s->>'verdict') AS outcome,s->>'timedOut'='true' AS timed_out,
          CASE WHEN jsonb_typeof(s->'durationMs')='number' THEN (s->>'durationMs')::double precision ELSE 0 END AS duration,
          CASE WHEN jsonb_typeof(s->'providerLatencyMs')='number' THEN (s->>'providerLatencyMs')::double precision ELSE 0 END AS provider
        FROM runtime_event
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(metadata->'trace')='array' THEN metadata->'trace' ELSE '[]'::jsonb END) s
        WHERE ${predicate} AND occurred_at >= ${new Date(start).toISOString()}::timestamptz
      ), grouped AS (
        SELECT steps.*, g.scope, g.kind, g.key FROM steps CROSS JOIN LATERAL (
          SELECT '' AS scope, step_kind AS kind, name AS key
          UNION ALL SELECT coalesce(guardrail_id,''), step_kind, name WHERE guardrail_id IS NOT NULL
          UNION ALL SELECT '', 'policy', policy_id WHERE policy_id IS NOT NULL
        ) g WHERE g.kind IN ('rail','action','policy')
      ) SELECT scope,kind,key,count(*)::int AS invocations,
        min(risk) AS risk,min(policy_id) AS policy_id,min(policy_version) AS policy_version,
        min(rail_type) AS rail_type,min(flow_name) AS flow_name,min(action_name) AS action_name,
        min(action_version) AS action_version,min(parallel_group) AS parallel_group,
        array_remove(array_agg(DISTINCT rail_type),NULL) AS rail_types,
        array_remove(array_agg(DISTINCT parallel_group),NULL) AS parallel_groups,
        count(*) FILTER (WHERE outcome IN ('passed','safe','allow','complete'))::int AS passed,
        count(*) FILTER (WHERE outcome IN ('unsafe','block','transform','intervene','enforce'))::int AS intervened,
        count(*) FILTER (WHERE outcome='error')::int AS errors,
        count(*) FILTER (WHERE outcome='uncertain')::int AS uncertain,
        count(*) FILTER (WHERE timed_out)::int AS timeouts,
        percentile_disc(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY duration) AS latency,
        percentile_disc(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY provider) AS provider
      FROM grouped GROUP BY scope,kind,key`);
    const risks = await tx.execute(sql`SELECT coalesce(f->>'risk','unknown') AS risk,count(*)::int AS count
      FROM runtime_event CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(metadata->'findings')='array' THEN metadata->'findings' ELSE '[]'::jsonb END) f
      WHERE ${predicate} AND occurred_at >= ${new Date(start).toISOString()}::timestamptz GROUP BY 1`);
    const findings = await tx.execute(sql`WITH findings AS (
      SELECT request_id,occurred_at,CASE WHEN f->>'verdict'='error' THEN 'critical'
        WHEN f->>'verdict'='unsafe' AND CASE WHEN jsonb_typeof(f->'confidence')='number' THEN (f->>'confidence')::float8 >= .9 ELSE false END THEN 'high'
        WHEN f->>'verdict'='unsafe' OR CASE WHEN jsonb_typeof(f->'confidence')='number' THEN (f->>'confidence')::float8 >= .7 ELSE false END THEN 'medium' ELSE 'low' END AS severity
      FROM runtime_event CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(metadata->'findings')='array' THEN metadata->'findings' ELSE '[]'::jsonb END) f
      WHERE ${predicate} AND occurred_at >= ${new Date(start).toISOString()}::timestamptz
    ) SELECT count(*)::int AS total,count(*) FILTER(WHERE severity='critical')::int AS critical,
      count(*) FILTER(WHERE severity='high')::int AS high,count(*) FILTER(WHERE severity='medium')::int AS medium,
      count(*) FILTER(WHERE severity='low')::int AS low,count(DISTINCT request_id)::int AS affected_traces,max(occurred_at) AS latest_at FROM findings`);
    const guards = await tx.execute(sql`SELECT g.id,g.name,g.draft_revision,v.source_draft_revision,v.status,
      coalesce((v.metrics->>'p95LatencyMs')::double precision,0) AS p95 FROM guardrail g
      LEFT JOIN LATERAL (SELECT source_draft_revision,status,metrics FROM guardrail_validation_run WHERE guardrail_id=g.id ORDER BY created_at DESC LIMIT 1) v ON true WHERE g.deleted_at IS NULL`);
    const deps = await tx.execute(sql`SELECT id,name,guardrail_id,enabled FROM guardrail_deployment WHERE deleted_at IS NULL`);
    const ints = await tx.execute(sql`SELECT id,name FROM integration WHERE deleted_at IS NULL`);
    return { ...assembleMetrics(scope, now, step, interval, totals.rows, components.rows, risks.rows, guards.rows, deps.rows, ints.rows), findings_summary: findings.rows[0] };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export function assembleMetrics(scope: MetricScope, now: number, step: number, interval: string, rows: Row[], components: Row[], risks: Row[], guards: Row[], deps: Row[], ints: Row[]) {
  const empty = { total: 0, allowed: 0, blocked: 0, intervened: 0, errors: 0, timeout_count: 0, evidence: 0, fail_closed_count: 0, slo_breach_count: 0, unassigned: 0, degraded_integrations: 0, peak_active_concurrency: 0, rail_invocations: 0, action_invocations: 0, model_invocations: 0, cache_hits: 0, cache_misses: 0 };
  const latencies = (r: Row) => ({ p50_latency_ms: Math.round(r.latency?.[0] ?? 0), p95_latency_ms: Math.round(r.latency?.[1] ?? 0), p99_latency_ms: Math.round(r.latency?.[2] ?? 0), provider_p50_ms: Math.round(r.provider?.[0] ?? 0), provider_p95_ms: Math.round(r.provider?.[1] ?? 0), provider_p99_ms: Math.round(r.provider?.[2] ?? 0), queue_p50_ms: Math.round(r.queue?.[0] ?? 0), queue_p95_ms: Math.round(r.queue?.[1] ?? 0), queue_p99_ms: Math.round(r.queue?.[2] ?? 0) });
  const normalize = (r: Row): Row => ({ ...empty, ...r, ...latencies(r), block_rate: pct(r.blocked ?? 0,r.total ?? 0), intervention_rate: pct((r.blocked ?? 0)+(r.intervened ?? 0),r.total ?? 0), error_rate: pct(r.errors ?? 0,r.total ?? 0) });
  const current = normalize(rows.find(r => r.kind==='period' && r.key==='current') ?? empty);
  const previous = normalize(rows.find(r => r.kind==='period' && r.key==='previous') ?? empty);
  const guardNames = new Map(guards.map(r => [r.id,r.name]));
  const depNames = new Map(deps.map(r => [r.id,r.name]));
  const intNames = new Map(ints.map(r => [r.id,r.name]));
  const comps: Row[] = components.map(r => ({ ...r, ...latencies(r), name: r.key, policy_version: Number.isFinite(Number.parseInt(r.policy_version)) ? Number.parseInt(r.policy_version) : null }));
  const distribution = (kind: string) => rows.filter(r => r.kind===kind).map(normalize);
  const points = (id?: string) => {
    const values = new Map(rows.filter(r => id === undefined ? r.kind==='trend' : r.kind==='guardrail-trend' && JSON.parse(r.key)[0]===id).map(r => [id === undefined ? Number(r.key) : JSON.parse(r.key)[1],r]));
    const out = [];
    for (let at=Math.floor((now-metricWindows[scope.window])/step)*step; at<=now; at+=step) {
      const r=normalize(values.get(at) ?? empty);
      out.push({ timestamp: new Date(at).toISOString(), total:r.total,allowed:r.allowed,blocked:r.blocked,transformed:r.intervened,errored:r.errors,timed_out:r.timeout_count,p50_latency_ms:r.p50_latency_ms,p95_latency_ms:r.p95_latency_ms,p99_latency_ms:r.p99_latency_ms });
    }
    return out;
  };
  const trend=points(), policies=comps.filter(r => r.kind==='policy');
  const policyTotal=policies.reduce((n,r)=>n+r.invocations,0);
  const scopedDeps=deps.filter(r => (!scope.guardrailId || r.guardrail_id===scope.guardrailId) && (!scope.deploymentId || r.id===scope.deploymentId));
  return {
    ...current, window:scope.window,window_start:new Date(now-metricWindows[scope.window]).toISOString(),
    scope:{ guardrail_id:scope.guardrailId ?? null,guardrail_name:guardNames.get(scope.guardrailId) ?? null },
    data_availability:{runtime_events:'complete',execution_evidence:!current.total || current.evidence===current.total ? 'collected' : current.evidence ? 'partial' : 'not_collected',returned_events:current.total+previous.total,matching_events:current.total+previous.total},
    comparison:{previous_total_decisions:previous.total,request_delta_pct:delta(current.total,previous.total),previous_intervention_rate:previous.total?previous.intervention_rate:null,intervention_rate_delta_pp:previous.total?Math.round((current.intervention_rate-previous.intervention_rate)*100)/100:null,previous_runtime_p95_ms:previous.total?previous.p95_latency_ms:null,runtime_p95_delta_ms:previous.total?current.p95_latency_ms-previous.p95_latency_ms:null,previous_error_rate:previous.total?previous.error_rate:null,error_rate_delta_pp:previous.total?Math.round((current.error_rate-previous.error_rate)*100)/100:null},
    total_decisions:current.total,runtime_p50_ms:current.p50_latency_ms,runtime_p95_ms:current.p95_latency_ms,runtime_p99_ms:current.p99_latency_ms,
    cache_hit_rate:pct(current.cache_hits,current.cache_hits+current.cache_misses),
    runtime_engine_counts:distribution('engine').map(r=>({runtime_engine:r.key,count:r.total})),
    rail_metrics:comps.filter(r=>r.scope==='' && r.kind==='rail'),action_metrics:comps.filter(r=>r.scope==='' && r.kind==='action'),
    latency_slo:{p95_budget_ms:2500,p99_budget_ms:5000,p95_status:current.p95_latency_ms<=2500?'healthy':'breached',p99_status:current.p99_latency_ms<=5000?'healthy':'breached'},
    latest_validation_p95_ms:guards.reduce((n,r)=>Math.max(n,r.p95),0),active_deployments:scopedDeps.filter(r=>r.enabled).length,total_deployments:scopedDeps.length,
    guardrails_needing_test:guards.filter(r=>r.status!=='passed'||r.source_draft_revision!==r.draft_revision).length,total_guardrails:guards.length,total_integrations:ints.length,risk_counts:risks,
    guardrail_distribution:distribution('guardrail').filter(r=>r.key).map(r=>({...r,guardrail_id:r.key,name:guardNames.get(r.key)??r.key,share:pct(r.total,current.total),rail_p95_ms:quantile(comps.filter(c=>c.scope===r.key&&c.kind==='rail').map(c=>c.p95_latency_ms),.95),action_p95_ms:quantile(comps.filter(c=>c.scope===r.key&&c.kind==='action').map(c=>c.p95_latency_ms),.95)})),
    caller_distribution:distribution('caller').map(r=>{const [integration_id,deployment_id]=JSON.parse(r.key);return {...r,integration_id,deployment_id,integration_name:intNames.get(integration_id)??integration_id??'Unassigned',deployment_name:depNames.get(deployment_id)??deployment_id??'Unassigned',requests:r.total,share:pct(r.total,current.total),guardrail_versions:r.versions,protocol:r.protocol??'unknown'};}),
    version_distribution:distribution('version').filter(r=>JSON.parse(r.key)[0]).map(r=>{const [guardrail_id,guardrail_version]=JSON.parse(r.key);return {...r,guardrail_id,guardrail_version:guardrail_version??'',guardrail_name:guardNames.get(guardrail_id)??guardrail_id,requests:r.total,share:pct(r.total,current.total),slo_breaches:r.slo_breach_count};}),
    policy_distribution:policies.map(r=>({...r,policy_id:r.key,hit_share:pct(r.invocations,policyTotal),hits_per_request:current.total?Math.round(r.invocations/current.total*100)/100:0})),
    unassigned_requests:current.unassigned,interval,trend,trend_series:{none:[{name:'All traffic',points:trend}],guardrail:distribution('guardrail').filter(r=>r.key).map(r=>({name:guardNames.get(r.key)??r.key,points:points(r.key)}))},
  };
}
