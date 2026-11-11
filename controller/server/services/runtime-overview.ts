import { sql, type SQL } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { currentProjectId } from "./project-context.js";
import { metricWindows, type MetricScope } from "./runtime-metric-results.js";

type Reader = Pick<ControllerDatabase, "execute">;
type Bucket = {
  guardrail_id: string; endpoint_id: string; bucket_start: Date;
  counts: Record<string, number>; histogram: Record<string, number>;
};
type Aggregate = {
  kind: string; key: string; counts: Record<string, number>;
  histogram: Map<number, number>; endpoints: Set<string>;
};

/** Whole minute boundaries keep both comparison windows equal and disjoint.
 * Coarse buckets cover the interior; minute buckets cover BOTH window edges,
 * so changing resolution never silently includes an entire boundary hour. */
export function overviewRanges(scope: MetricScope, now: number) {
  const end = Math.ceil(now / 60_000) * 60_000;
  const start = end - metricWindows[scope.window];
  const resolution = scope.window === "1h" ? 60 : scope.window === "24h" ? 900 : 3600;
  const ranges: Array<{ resolution: number; from: number; until: number }> = [];
  for (const [from, until] of [[start - metricWindows[scope.window], start], [start, end]]) {
    if (resolution === 60) ranges.push({ resolution, from: from!, until: until! });
    else {
      const lower = Math.ceil(from! / (resolution * 1000)) * resolution * 1000;
      const upper = Math.floor(until! / (resolution * 1000)) * resolution * 1000;
      if (from! < lower) ranges.push({ resolution: 60, from: from!, until: lower });
      if (lower < upper) ranges.push({ resolution, from: lower, until: upper });
      if (upper < until!) ranges.push({ resolution: 60, from: upper, until: until! });
    }
  }
  return { end, start, ranges };
}

export async function queryOverviewTotals(db: Reader, scope: MetricScope, now: number, step: number,
  execute: <T>(query: PromiseLike<T>) => Promise<T> = query => Promise.resolve(query)) {
  const { start, ranges } = overviewRanges(scope, now);
  const predicates: SQL[] = [sql`(${sql.join(ranges.map(range => sql`(resolution=${range.resolution}
    AND bucket_start >= ${new Date(range.from).toISOString()}::timestamptz
    AND bucket_start < ${new Date(range.until).toISOString()}::timestamptz)`), sql` OR `)})`];
  const projectId = currentProjectId();
  if (projectId !== null) predicates.push(sql`project_id=${projectId}`);
  if (scope.guardrailId) predicates.push(sql`guardrail_id=${scope.guardrailId}`);
  if (scope.routerId) predicates.push(sql`router_id=${scope.routerId}`);
  const result = await execute(db.execute<Bucket>(sql`SELECT guardrail_id,endpoint_id,bucket_start,counts,histogram
    FROM runtime_overview_bucket WHERE ${sql.join(predicates, sql` AND `)} AND (counts->>'total')::bigint > 0`));
  const aggregates = new Map<string, Aggregate>();
  const add = (kind: string, key: string, bucket: Bucket) => {
    const identity = JSON.stringify([kind, key]);
    let aggregate = aggregates.get(identity);
    if (!aggregate) {
      aggregate = { kind, key, counts: {}, histogram: new Map(), endpoints: new Set() };
      aggregates.set(identity, aggregate);
    }
    for (const [name, value] of Object.entries(bucket.counts)) aggregate.counts[name] = (aggregate.counts[name] ?? 0) + Number(value);
    for (const [bin, value] of Object.entries(bucket.histogram)) {
      if (value > 0) aggregate.histogram.set(Number(bin), (aggregate.histogram.get(Number(bin)) ?? 0) + Number(value));
    }
    if (bucket.counts.errors! > 0 && bucket.endpoint_id) aggregate.endpoints.add(bucket.endpoint_id);
  };
  for (const bucket of result.rows) {
    const at = new Date(bucket.bucket_start).getTime();
    const current = at >= start;
    add("period", current ? "current" : "previous", bucket);
    if (!current) continue;
    add("guardrail", bucket.guardrail_id, bucket);
    add("trend", String(Math.floor(at / step) * step), bucket);
    add("guardrail-trend", JSON.stringify([bucket.guardrail_id, Math.floor(at / step) * step]), bucket);
  }
  return [...aggregates.values()].map(aggregate => {
    const histogram = [...aggregate.histogram].sort(([a], [b]) => a - b);
    const quantile = (q: number) => {
      const rank = Math.ceil(aggregate.counts.total! * q);
      let seen = 0;
      for (const [upper, count] of histogram) { seen += count; if (seen >= rank) return upper; }
      return 0;
    };
    return { kind: aggregate.kind, key: aggregate.key, ...aggregate.counts,
      degraded_endpoints: aggregate.endpoints.size, latency: [.5,.95,.99].map(quantile) };
  });
}
