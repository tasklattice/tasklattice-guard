import { and, eq, gt, ilike, sql } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { projects, runnerPools, runnerInstances } from "../db/schema.js";
import {
  directoryPage,
  searchPattern,
  type DirectoryQuery,
} from "../../shared/directory.js";
import { currentProjectId } from "./project-context.js";
import { projectPoolAllocation } from "./runner-allocation.js";
import { NotFoundError } from "../domain/errors.js";
import {
  calculatePoolCapacityFromTotals,
  type PoolCapacityTotals,
} from "../domain/capacity.js";

export class RunnerDirectory {
  constructor(
    private readonly db: ControllerDatabase,
    private readonly heartbeatSeconds: number,
  ) {}
  private visibility() {
    const projectId = currentProjectId();
    return projectId
      ? sql`exists(select 1 from ${projects} where ${projects.id}=${projectId} and ${projectPoolAllocation})`
      : undefined;
  }
  async list(query: DirectoryQuery) {
    const rows = await this.db
      .select({
        id: runnerPools.id,
        name: runnerPools.name,
        totalCount: sql<number>`(select count(*)::int from runner_instance r where r.pool_id=${runnerPools.id})`,
        connectedCount: sql<number>`(select count(*)::int from runner_instance r where r.pool_id=${runnerPools.id} and r.status<>'offline')`,
      })
      .from(runnerPools)
      .where(
        and(
          this.visibility(),
          query.cursor ? gt(runnerPools.id, query.cursor) : undefined,
          query.q ? ilike(runnerPools.name, searchPattern(query.q)) : undefined,
        ),
      )
      .orderBy(runnerPools.id)
      .limit(query.limit + 1);
    return directoryPage(rows, query.limit, (row) => row.id);
  }
  async detail(id: string, query: DirectoryQuery) {
    const [pool] = await this.db
      .select()
      .from(runnerPools)
      .where(and(eq(runnerPools.id, id), this.visibility()))
      .limit(1);
    if (!pool) throw new NotFoundError("Runner pool", id);
    // Aggregate the whole pool in PostgreSQL; never calculate capacity from a paginated slice.
    const {
      rows: [totals],
    } = await this.db.execute<
      PoolCapacityTotals & {
        connected: number;
        pending: number;
        syncing: number;
        hasMetrics: boolean;
      }
    >(sql`
      with metrics as (
        select *,status in ('ready','busy','saturated') as serving,
          greatest(0,coalesce((load->>'requestsDelta')::float8,0))/greatest(0.001,coalesce((load->>'observationIntervalMs')::float8,${this.heartbeatSeconds * 1000})/1000) as rps,
          case when coalesce((load->>'requestsDelta')::float8,0)>0 then (coalesce((load->>'errorsDelta')::float8,0)+coalesce((load->>'timeoutsDelta')::float8,0))/(load->>'requestsDelta')::float8 else 0 end as error_rate
        from runner_instance where pool_id=${id}
      ) select count(*)::int as "totalRunners",count(*) filter(where serving)::int as "readyRunners",
        count(*) filter(where status<>'offline')::int as connected,
        count(*) filter(where status<>'offline' and applied_generation<>desired_generation)::int as pending,
        count(*) filter(where status='syncing')::int as syncing,
        coalesce(bool_or(serving and load is not null),false) as "hasMetrics",
        coalesce(sum(greatest(0,coalesce((load->>'maxConcurrency')::float8,max_concurrency))) filter(where serving),0) as "totalConcurrency",
        coalesce(sum(greatest(0,(load->>'inflight')::float8)) filter(where serving),0) as inflight,
        coalesce(sum(greatest(0,(load->>'queueDepth')::float8)) filter(where serving),0) as "queueDepth",
        coalesce(sum(rps) filter(where serving),0) as "requestsPerSecond",
        coalesce(max(greatest(0,(load->>'cpuUtilization')::float8)) filter(where serving),0) as "cpuUtilization",
        coalesce(max(greatest(0,(load->>'memoryUtilization')::float8)) filter(where serving),0) as "memoryUtilization",
        coalesce(max(error_rate) filter(where serving),0) as "maxErrorRate",
        coalesce(sum(greatest(0,error_rate)*rps) filter(where serving),0) as "weightedErrorNumerator",
        coalesce(max(greatest(0,(load->>'latencyP95Ms')::float8)) filter(where serving),0) as "worstRunnerLatencyP95Ms"
      from metrics`);
    const rows = await this.db
      .select()
      .from(runnerInstances)
      .where(
        and(
          eq(runnerInstances.poolId, id),
          query.cursor ? gt(runnerInstances.runnerId, query.cursor) : undefined,
          query.q
            ? ilike(runnerInstances.runnerId, searchPattern(query.q))
            : undefined,
        ),
      )
      .orderBy(runnerInstances.runnerId)
      .limit(query.limit + 1);
    const instances = directoryPage(
      rows.map(({ controlSessionId: _session, ...row }) => row),
      query.limit,
      (row) => row.runnerId,
    );
    return {
      ...pool,
      instances: instances.items,
      nextCursor: instances.nextCursor,
      counts: {
        total: totals!.totalRunners,
        connected: totals!.connected,
        pending: totals!.pending,
        syncing: totals!.syncing,
        hasMetrics: totals!.hasMetrics,
      },
      capacity: calculatePoolCapacityFromTotals(
        totals!,
        pool.safeRpsPerRunner,
        undefined,
        1.25,
        1,
      ),
    };
  }
}
