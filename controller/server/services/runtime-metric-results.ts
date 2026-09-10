export const metricWindows = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "15d": 1_296_000_000,
  "30d": 2_592_000_000,
};
export type MetricScope = {
  window: keyof typeof metricWindows;
  guardrailId?: string | undefined;
  routerId?: string | undefined;
};
// Rows contain aggregate values only. Protected content and individual traces never leave PostgreSQL.
type Row = Record<string, any>;
const pct = (n: number, d: number) =>
  d ? Math.round((n / d) * 10_000) / 100 : 0;
const delta = (n: number, d: number) =>
  d ? Math.round(((n - d) / d) * 10_000) / 100 : n ? null : 0;
const quantile = (a: number[], q: number) =>
  a.length
    ? ([...a].sort((a, b) => a - b)[Math.ceil(a.length * q) - 1] ?? 0)
    : 0;

export function assembleMetrics(
  scope: MetricScope,
  now: number,
  step: number,
  interval: string,
  rows: Row[],
  components: Row[],
  risks: Row[],
  guards: Row[],
  deps: Row[],
  ints: Row[],
) {
  const empty = {
    total: 0,
    allowed: 0,
    blocked: 0,
    intervened: 0,
    errors: 0,
    timeout_count: 0,
    evidence: 0,
    fail_closed_count: 0,
    slo_breach_count: 0,
    unassigned: 0,
    degraded_endpoints: 0,
    peak_active_concurrency: 0,
    rail_invocations: 0,
    action_invocations: 0,
    model_invocations: 0,
    cache_hits: 0,
    cache_misses: 0,
  };
  const latencies = (r: Row) => ({
    p50_latency_ms: Math.round(r.latency?.[0] ?? 0),
    p95_latency_ms: Math.round(r.latency?.[1] ?? 0),
    p99_latency_ms: Math.round(r.latency?.[2] ?? 0),
    provider_p50_ms: Math.round(r.provider?.[0] ?? 0),
    provider_p95_ms: Math.round(r.provider?.[1] ?? 0),
    provider_p99_ms: Math.round(r.provider?.[2] ?? 0),
    queue_p50_ms: Math.round(r.queue?.[0] ?? 0),
    queue_p95_ms: Math.round(r.queue?.[1] ?? 0),
    queue_p99_ms: Math.round(r.queue?.[2] ?? 0),
  });
  const normalize = (r: Row): Row => ({
    ...empty,
    ...r,
    ...latencies(r),
    block_rate: pct(r.blocked ?? 0, r.total ?? 0),
    intervention_rate: pct(
      (r.blocked ?? 0) + (r.intervened ?? 0),
      r.total ?? 0,
    ),
    error_rate: pct(r.errors ?? 0, r.total ?? 0),
  });
  const current = normalize(
    rows.find((r) => r.kind === "period" && r.key === "current") ?? empty,
  );
  const previous = normalize(
    rows.find((r) => r.kind === "period" && r.key === "previous") ?? empty,
  );
  const guardNames = new Map(guards.map((r) => [r.id, r.name]));
  const depNames = new Map(deps.map((r) => [r.id, r.name]));
  const intNames = new Map(ints.map((r) => [r.id, r.name]));
  const comps: Row[] = components.map((r) => ({
    ...r,
    ...latencies(r),
    name: r.key,
    policy_version: Number.isFinite(Number.parseInt(r.policy_version))
      ? Number.parseInt(r.policy_version)
      : null,
  }));
  const distribution = (kind: string) =>
    rows.filter((r) => r.kind === kind).map(normalize);
  const points = (id?: string) => {
    const values = new Map(
      rows
        .filter((r) =>
          id === undefined
            ? r.kind === "trend"
            : r.kind === "guardrail-trend" && JSON.parse(r.key)[0] === id,
        )
        .map((r) => [
          id === undefined ? Number(r.key) : JSON.parse(r.key)[1],
          r,
        ]),
    );
    const out = [];
    for (
      let at = Math.floor((now - metricWindows[scope.window]) / step) * step;
      at <= now;
      at += step
    ) {
      const r = normalize(values.get(at) ?? empty);
      out.push({
        timestamp: new Date(at).toISOString(),
        total: r.total,
        allowed: r.allowed,
        blocked: r.blocked,
        transformed: r.intervened,
        errored: r.errors,
        timed_out: r.timeout_count,
        p50_latency_ms: r.p50_latency_ms,
        p95_latency_ms: r.p95_latency_ms,
        p99_latency_ms: r.p99_latency_ms,
      });
    }
    return out;
  };
  const trend = points(),
    policies = comps.filter((r) => r.kind === "policy");
  const policyTotal = policies.reduce((n, r) => n + r.invocations, 0);
  const scopedDeps = deps.filter(
    (r) =>
      (!scope.guardrailId || r.guardrail_id === scope.guardrailId) &&
      (!scope.routerId || r.id === scope.routerId),
  );
  return {
    ...current,
    window: scope.window,
    window_start: new Date(now - metricWindows[scope.window]).toISOString(),
    scope: {
      guardrail_id: scope.guardrailId ?? null,
      guardrail_name: guardNames.get(scope.guardrailId) ?? null,
    },
    data_availability: {
      runtime_events: "complete",
      execution_evidence:
        !current.total || current.evidence === current.total
          ? "collected"
          : current.evidence
            ? "partial"
            : "not_collected",
      returned_events: current.total + previous.total,
      matching_events: current.total + previous.total,
    },
    comparison: {
      previous_total_decisions: previous.total,
      request_delta_pct: delta(current.total, previous.total),
      previous_intervention_rate: previous.total
        ? previous.intervention_rate
        : null,
      intervention_rate_delta_pp: previous.total
        ? Math.round(
            (current.intervention_rate - previous.intervention_rate) * 100,
          ) / 100
        : null,
      previous_runtime_p95_ms: previous.total ? previous.p95_latency_ms : null,
      runtime_p95_delta_ms: previous.total
        ? current.p95_latency_ms - previous.p95_latency_ms
        : null,
      previous_error_rate: previous.total ? previous.error_rate : null,
      error_rate_delta_pp: previous.total
        ? Math.round((current.error_rate - previous.error_rate) * 100) / 100
        : null,
    },
    total_decisions: current.total,
    runtime_p50_ms: current.p50_latency_ms,
    runtime_p95_ms: current.p95_latency_ms,
    runtime_p99_ms: current.p99_latency_ms,
    cache_hit_rate: pct(
      current.cache_hits,
      current.cache_hits + current.cache_misses,
    ),
    runtime_engine_counts: distribution("engine").map((r) => ({
      runtime_engine: r.key,
      count: r.total,
    })),
    rail_metrics: comps.filter((r) => r.scope === "" && r.kind === "rail"),
    action_metrics: comps.filter((r) => r.scope === "" && r.kind === "action"),
    latency_slo: {
      p95_budget_ms: 2500,
      p99_budget_ms: 5000,
      p95_status: current.p95_latency_ms <= 2500 ? "healthy" : "breached",
      p99_status: current.p99_latency_ms <= 5000 ? "healthy" : "breached",
    },
    latest_validation_p95_ms: guards.reduce((n, r) => Math.max(n, r.p95), 0),
    active_routers: scopedDeps.filter((r) => r.enabled).length,
    total_routers: scopedDeps.length,
    guardrails_needing_test: guards.filter(
      (r) =>
        r.status !== "passed" || r.source_draft_revision !== r.draft_revision,
    ).length,
    total_guardrails: guards.length,
    total_endpoints: ints.length,
    risk_counts: risks,
    guardrail_distribution: distribution("guardrail")
      .filter((r) => r.key)
      .map((r) => ({
        ...r,
        guardrail_id: r.key,
        name: guardNames.get(r.key) ?? r.key,
        share: pct(r.total, current.total),
        rail_p95_ms: quantile(
          comps
            .filter((c) => c.scope === r.key && c.kind === "rail")
            .map((c) => c.p95_latency_ms),
          0.95,
        ),
        action_p95_ms: quantile(
          comps
            .filter((c) => c.scope === r.key && c.kind === "action")
            .map((c) => c.p95_latency_ms),
          0.95,
        ),
      })),
    caller_distribution: distribution("caller").map((r) => {
      const [endpoint_id, router_id] = JSON.parse(r.key);
      return {
        ...r,
        endpoint_id,
        router_id,
        endpoint_name:
          intNames.get(endpoint_id) ?? endpoint_id ?? "Unassigned",
        router_name:
          depNames.get(router_id) ?? router_id ?? "Unassigned",
        requests: r.total,
        share: pct(r.total, current.total),
        guardrail_versions: r.versions,
        protocol: r.protocol ?? "unknown",
      };
    }),
    version_distribution: distribution("version")
      .filter((r) => JSON.parse(r.key)[0])
      .map((r) => {
        const [guardrail_id, guardrail_version] = JSON.parse(r.key);
        return {
          ...r,
          guardrail_id,
          guardrail_version: guardrail_version ?? "",
          guardrail_name: guardNames.get(guardrail_id) ?? guardrail_id,
          requests: r.total,
          share: pct(r.total, current.total),
          slo_breaches: r.slo_breach_count,
        };
      }),
    policy_distribution: policies.map((r) => ({
      ...r,
      policy_id: r.key,
      hit_share: pct(r.invocations, policyTotal),
      hits_per_request: current.total
        ? Math.round((r.invocations / current.total) * 100) / 100
        : 0,
    })),
    unassigned_requests: current.unassigned,
    interval,
    trend,
    trend_series: {
      none: [{ name: "All traffic", points: trend }],
      guardrail: distribution("guardrail")
        .filter((r) => r.key)
        .map((r) => ({
          name: guardNames.get(r.key) ?? r.key,
          points: points(r.key),
        })),
    },
  };
}
