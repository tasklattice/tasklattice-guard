import { projectPoolAllocation } from "./runner-allocation.js";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { performance } from "node:perf_hooks";
import { admissionBucketSeconds, admissionOutcomes, admissionSnapshotMaxBytes, admissionSnapshotSchema,
  type AdmissionMonitorEntity, type AdmissionMonitorState, type AdmissionProjectSnapshot, type AdmissionValues,
  type AvailableAdmissionSnapshot } from "../../shared/admission-monitor.js";
import type { ControllerDatabase } from "../db/client.js";
import { runnerInstances, runnerPools, projectGroups, projects } from "../db/schema.js";
import { assertPlatformAuthority } from "./project-context.js";

export type AdmissionInventory = {
  groups: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string; groupId: string }>;
  pools: Array<{ id: string; name: string; groupId: string; projectIds: string[] }>;
  runners: Array<{ runnerId: string; bootId: string; controlSessionId: string | null; poolId: string; status: string; disconnectedAt: Date | null; sessionCurrent: boolean }>;
};
type SourceIdentity = { runnerId: string; bootId: string; controlSessionId: string | null; poolId: string; sequence: number };
type Histogram = AdmissionProjectSnapshot["wait"];
type Interval = { seconds: number; outcomes: AdmissionProjectSnapshot["outcomes"]; wait: Histogram; held: Histogram };
type Source = SourceIdentity & { receivedAt: number; snapshot: AvailableAdmissionSnapshot | null; reason: string | null; intervals: Map<string, Interval>; intervalReason: string };
type Options = { monotonicNow?: () => number; wallNow?: () => number; staleAfterMs?: number; inventory?: (poolId?: string) => Promise<AdmissionInventory> };
type Cache = { placement: string; signature: string; touched: number; history: Map<string, Array<{ at: number; values: AdmissionValues }>> };
const maxSources = 32, maxProjects = 128, maxGroups = 32, maxPools = 32, maxHistory = 60, maxFilters = 4, retentionMs = 600_000;
const nullValues = (): AdmissionValues => ({ active: null, queued: null, capacity: null, occupancyPercent: null, attempts: null,
  admitted: null, rejected: null, cancelled: null, attemptsPerSecond: null, admittedPerSecond: null, rejectedPerSecond: null, waitP95Ms: null, heldP95Ms: null });
const total = (values: AdmissionProjectSnapshot["outcomes"]) => admissionOutcomes.reduce((sum, key) => sum + values[key], 0);
const rejected = (values: AdmissionProjectSnapshot["outcomes"]) => values.queue_full + values.queue_timeout + values.rate_limited + values.unavailable;

/** Diagnostic state only: never grants serving or freshness authority. State is
 * bounded to32 current source processes and4 filtered histories of60 points per
 * bounded inventory. Restart, missing reports and counter resets produce gaps. */
export class ProjectAdmissionMonitor {
  private readonly sources = new Map<string, Source>();
  private readonly caches = new Map<string, Cache>();
  private readonly monotonic: () => number;
  private readonly wall: () => number;
  private readonly inventory: (poolId?: string) => Promise<AdmissionInventory>;
  readonly staleAfterMs: number;
  constructor(private readonly db: ControllerDatabase, options: Options = {}) {
    this.monotonic = options.monotonicNow ?? (() => performance.now());
    this.wall = options.wallNow ?? Date.now;
    this.staleAfterMs = Math.max(15_000, Math.min(120_000, options.staleAfterMs ?? 30_000));
    this.inventory = options.inventory ?? (poolId => this.loadInventory(poolId));
  }

  /** Identity and sequence come from the accepted DB heartbeat, never its JSON. */
  record(identity: SourceIdentity, payload?: Uint8Array | null): void {
    const now = this.monotonic(); this.prune(now);
    const previous = this.sources.get(identity.runnerId);
    if (previous && previous.bootId === identity.bootId && previous.controlSessionId === identity.controlSessionId && previous.sequence >= identity.sequence) return;
    if (!previous && this.sources.size >= maxSources) return;
    let snapshot: AvailableAdmissionSnapshot | null = null, reason: string | null = "missing_report";
    if (payload?.byteLength) {
      if (payload.byteLength > admissionSnapshotMaxBytes) reason = "payload_limit";
      else try {
        const parsed = admissionSnapshotSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)));
        if (!parsed.success) reason = "invalid_report";
        else if (!parsed.data.available) reason = parsed.data.reason;
        else { snapshot = parsed.data; reason = null; }
      } catch { reason = "invalid_report"; }
    }
    const intervals = new Map<string, Interval>();
    let intervalReason = "first_observation";
    if (snapshot && previous?.snapshot && previous.bootId === identity.bootId && previous.controlSessionId === identity.controlSessionId && previous.poolId === identity.poolId) {
      const seconds = snapshot.monotonicSeconds - previous.snapshot.monotonicSeconds;
      intervalReason = "counter_reset";
      if (seconds > 0 && seconds <= 120 && now - previous.receivedAt <= this.staleAfterMs * 2) {
        for (const row of snapshot.projects) {
          const before = previous.snapshot.projects.find(item => item.projectId === row.projectId);
          const interval = before && difference(row, before, seconds);
          if (interval) intervals.set(row.projectId, interval);
        }
        if (intervals.size === snapshot.projects.length) intervalReason = "available";
      }
    }
    this.sources.set(identity.runnerId, { ...identity, receivedAt: now, snapshot, reason, intervals, intervalReason });
  }

  async view(poolId?: string): Promise<AdmissionMonitorState> {
    assertPlatformAuthority();
    const inventory = await this.inventory(poolId);
    const now = this.monotonic(), at = this.wall(); this.prune(now);
    const overflow = inventory.groups.length > maxGroups || inventory.pools.length > maxPools || inventory.projects.length > maxProjects || inventory.runners.length > maxSources;
    const base = { observedAt: at, source: "authenticated_runner_heartbeat" as const, controllerLocal: true as const,
      staleAfterMs: this.staleAfterMs, selectedPoolId: poolId ?? null, pools: inventory.pools.slice(0, maxPools) };
    if (overflow) return { ...base, available: false, reason: "inventory_limit", groups: [], projects: [], sources: [] };
    const inspected = inventory.runners.map(runner => {
      const source = this.sources.get(runner.runnerId), age = source ? now - source.receivedAt : null;
      let reason = runner.status === "offline" || runner.disconnectedAt ? "offline" : runner.status === "syncing" ? "runner_syncing" : null;
      if (!reason && !runner.sessionCurrent) reason = "missing_current_session_report";
      if (!reason && (!source || source.bootId !== runner.bootId || source.controlSessionId !== runner.controlSessionId || source.poolId !== runner.poolId)) reason = "missing_current_session_report";
      if (!reason && (age === null || age < 0 || age > this.staleAfterMs)) reason = "stale";
      if (!reason && source!.reason) reason = source!.reason;
      if (!reason && source!.snapshot?.projects.some(row => !inventory.pools.find(pool => pool.id === runner.poolId)?.projectIds.includes(row.projectId))) reason = "project_group_mismatch";
      return { runner, source, reason, age: age === null || age < 0 ? null : age };
    });
    const placement = JSON.stringify([inventory.groups, inventory.pools, inventory.projects,
      inventory.runners.map(row => [row.runnerId, row.bootId, row.controlSessionId, row.poolId])]);
    const key = poolId ?? "*";
    let cache = this.caches.get(key);
    if (!cache || cache.placement !== placement) cache = { placement, signature: "", touched: now, history: new Map() };
    this.caches.delete(key); this.caches.set(key, cache); cache.touched = now;
    while (this.caches.size > maxFilters) this.caches.delete(this.caches.keys().next().value!);
    const signature = JSON.stringify(inspected.map(row => [row.runner.runnerId, row.source?.sequence, row.reason]));
    const entities = (kind: "group" | "project") => {
      const rows = kind === "group" ? inventory.groups.map(row => ({ ...row, groupId: row.id })) : inventory.projects;
      return rows.map(row => {
        const pools = inventory.pools.filter(pool => pool.groupId === row.groupId && (kind === "group" || pool.projectIds.includes(row.id)));
        const expected = inspected.filter(item => pools.some(pool => pool.id === item.runner.poolId));
        const reporting = expected.filter(item => !item.reason && item.source?.snapshot);
        const available = expected.length > 0 && reporting.length === expected.length;
        const selected = reporting.flatMap(item => item.source!.snapshot!.projects.filter(project => kind === "group" || project.projectId === row.id)
          .map(project => ({ project, interval: item.source!.intervals.get(project.projectId) })));
        const configured = kind === "group" || selected.length > 0;
        const good = available && configured;
        const intervalsAvailable = good && selected.every(item => item.interval !== undefined);
        const values = good ? aggregate(selected, kind === "group" ? reporting.reduce((sum, item) => sum + item.source!.snapshot!.capacity, 0)
          : selected.reduce((sum, item) => sum + item.project.limit, 0), intervalsAvailable) : nullValues();
        const entityKey = `${kind}:${row.id}`;
        const history = cache!.history.get(entityKey) ?? [];
        if (cache!.signature !== signature) { history.push({ at, values }); if (history.length > maxHistory) history.shift(); cache!.history.set(entityKey, history); }
        const reason = !expected.length ? "no_registered_runners" : !available ? expected.find(item => item.reason)?.reason ?? "missing_report"
          : !configured ? "not_configured" : !intervalsAvailable ? "interval_unavailable" : null;
        return { id: row.id, name: row.name, groupId: row.groupId, projectIds: kind === "group" ? inventory.projects.filter(project => project.groupId === row.groupId).map(project => project.id) : [row.id],
          poolIds: pools.map(pool => pool.id), available: good, intervalAvailable: intervalsAvailable, reason,
          reportingSources: reporting.length, expectedSources: expected.length, values, history: [...history] } satisfies AdmissionMonitorEntity;
      });
    };
    const groups = entities("group"), projectRows = entities("project"); cache.signature = signature;
    return { ...base, available: groups.some(row => row.available), reason: groups.some(row => row.available) ? null : "measurements_unavailable",
      groups, projects: projectRows, sources: inspected.map(row => ({ runnerId: row.runner.runnerId, poolId: row.runner.poolId,
        available: !row.reason, reason: row.reason, ageMs: row.age })) };
  }

  private prune(now: number) {
    for (const [key, source] of this.sources) if (now - source.receivedAt > retentionMs || now < source.receivedAt) this.sources.delete(key);
    for (const [key, cache] of this.caches) if (now - cache.touched > retentionMs || now < cache.touched) this.caches.delete(key);
  }
  private async loadInventory(poolId?: string): Promise<AdmissionInventory> {
    return this.db.transaction(async tx => {
    // Read one allocation/session snapshot without racing a supported move.
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext('traffic-router-bindings'))`);
    const pools = await tx.select({ id: runnerPools.id, name: runnerPools.name, groupId: runnerPools.groupId,
      projectIds: sql<string[]>`array(select ${projects.id} from ${projects} where ${projectPoolAllocation})` }).from(runnerPools)
      .where(poolId ? eq(runnerPools.id, poolId) : undefined).orderBy(asc(runnerPools.id)).limit(maxPools + 1);
    const selectedGroups = [...new Set(pools.map(pool => pool.groupId))];
    const groups = poolId && !selectedGroups.length ? [] : await tx.select({ id: projectGroups.id, name: projectGroups.name }).from(projectGroups)
      .where(poolId ? inArray(projectGroups.id, selectedGroups) : undefined).orderBy(asc(projectGroups.id)).limit(maxGroups + 1);
    const groupIds = poolId ? [...new Set(pools.map(pool => pool.groupId))] : groups.map(group => group.id);
    const members = groupIds.length ? await tx.select({ id: projects.id, name: projects.name, groupId: projects.groupId }).from(projects)
      .where(inArray(projects.groupId, groupIds)).orderBy(asc(projects.id)).limit(maxProjects + 1) : [];
    const runners = pools.length ? await tx.select({ runnerId: runnerInstances.runnerId, bootId: runnerInstances.bootId,
      controlSessionId: runnerInstances.controlSessionId, poolId: runnerInstances.poolId, status: runnerInstances.status, disconnectedAt: runnerInstances.disconnectedAt,
      sessionCurrent: sql<boolean>`exists (select 1 from runner_control_session s where s.id = ${runnerInstances.controlSessionId}
        and s.runner_id = ${runnerInstances.runnerId} and s.boot_id = ${runnerInstances.bootId} and s.pool_id = ${runnerInstances.poolId} and s.disconnected_at is null)` })
      .from(runnerInstances).where(inArray(runnerInstances.poolId, pools.map(pool => pool.id))).orderBy(asc(runnerInstances.runnerId)).limit(maxSources + 1) : [];
    return { groups: poolId ? groups.filter(group => groupIds.includes(group.id)) : groups, projects: members.filter(project => pools.some(pool => pool.projectIds.includes(project.id))), pools, runners };
    });
  }
}

function difference(row: AdmissionProjectSnapshot, before: AdmissionProjectSnapshot, seconds: number): Interval | null {
  const outcomes = Object.fromEntries(admissionOutcomes.map(key => [key, row.outcomes[key] - before.outcomes[key]])) as AdmissionProjectSnapshot["outcomes"];
  if (admissionOutcomes.some(key => outcomes[key] < 0) || row.limit !== before.limit) return null;
  const histogram = (after: Histogram, previous: Histogram): Histogram | null => {
    const buckets = after.buckets.map((value, index) => value - previous.buckets[index]!);
    const count = after.count - previous.count, totalSeconds = after.totalSeconds - previous.totalSeconds;
    return count < 0 || totalSeconds < 0 || buckets.some((value, index) => value < 0 || (index > 0 && value < buckets[index - 1]!)) || buckets.at(-1) !== count
      ? null : { buckets, count, totalSeconds };
  };
  const wait = histogram(row.wait, before.wait), held = histogram(row.held, before.held);
  return wait && held ? { seconds, outcomes, wait, held } : null;
}
function p95(histograms: Histogram[]): number | null {
  const count = histograms.reduce((sum, histogram) => sum + histogram.count, 0);
  if (!count) return null;
  const buckets = Array.from({ length: admissionBucketSeconds.length + 1 }, (_, index) => histograms.reduce((sum, row) => sum + row.buckets[index]!, 0));
  const rank = count * 0.95;
  const index = buckets.findIndex(value => value >= rank);
  // The open-ended final bucket cannot supply an upper latency bound.
  if (index < 0 || index === admissionBucketSeconds.length) return null;
  const lower = index === 0 ? 0 : admissionBucketSeconds[index - 1]!, upper = admissionBucketSeconds[index]!;
  const before = index === 0 ? 0 : buckets[index - 1]!, width = buckets[index]! - before;
  return (lower + (upper - lower) * (rank - before) / width) * 1000;
}
function aggregate(rows: Array<{ project: AdmissionProjectSnapshot; interval: Interval | undefined }>, capacity: number, intervalsAvailable: boolean): AdmissionValues {
  const sum = (read: (row: AdmissionProjectSnapshot) => number) => rows.reduce((value, row) => value + read(row.project), 0);
  const intervals = intervalsAvailable ? rows.map(row => row.interval!) : [];
  const active = sum(row => row.active);
  return { active, queued: sum(row => row.queued), capacity, occupancyPercent: capacity > 0 ? active / capacity * 100 : null,
    attempts: sum(row => total(row.outcomes)), admitted: sum(row => row.outcomes.admitted), rejected: sum(row => rejected(row.outcomes)), cancelled: sum(row => row.outcomes.cancelled),
    attemptsPerSecond: intervalsAvailable ? intervals.reduce((value, row) => value + total(row.outcomes) / row.seconds, 0) : null,
    admittedPerSecond: intervalsAvailable ? intervals.reduce((value, row) => value + row.outcomes.admitted / row.seconds, 0) : null,
    rejectedPerSecond: intervalsAvailable ? intervals.reduce((value, row) => value + rejected(row.outcomes) / row.seconds, 0) : null,
    waitP95Ms: intervalsAvailable ? p95(intervals.map(row => row.wait)) : null,
    heldP95Ms: intervalsAvailable ? p95(intervals.map(row => row.held)) : null };
}
