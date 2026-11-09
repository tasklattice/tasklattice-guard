export type RunnerCapacityInput = {
  status: string;
  inflight: number;
  maxConcurrency: number;
  queueDepth: number;
  cpuUtilization: number;
  memoryUtilization: number;
  requestsPerSecond: number;
  errorRate: number;
  latencyP95Ms: number;
};

export type PoolCapacity = {
  readyRunners: number;
  totalRunners: number;
  totalConcurrency: number;
  inflight: number;
  queueDepth: number;
  requestsPerSecond: number;
  currentRps: number;
  safeRpsCapacity: number;
  headroomRps: number;
  utilization: number;
  inflightUtilization: number;
  cpuUtilization: number;
  memoryUtilization: number;
  errorRate: number;
  /** Worst per-Runner heartbeat-window p95. This is not a fleet-wide p95. */
  worstRunnerLatencyP95Ms: number;
  /** @deprecated Use worstRunnerLatencyP95Ms or aggregate Runner histograms in Prometheus. */
  latencyP95Ms: number;
  status: "ready" | "busy" | "saturated" | "degraded" | "offline";
  recommendedReplicas: number;
  bottleneck: "concurrency" | "queue" | "cpu" | "memory" | "none";
};

export function calculatePoolCapacity(
  runners: readonly RunnerCapacityInput[],
  safeRpsPerRunner: number,
  predictedPeakRps?: number,
  safetyFactor = 1.25,
  minimumReplicas = 1,
): PoolCapacity {
  const ready = runners.filter((runner) => ["ready", "busy", "saturated"].includes(runner.status));
  const totalConcurrency = ready.reduce((sum, runner) => sum + Math.max(0, runner.maxConcurrency), 0);
  const inflight = ready.reduce((sum, runner) => sum + Math.max(0, runner.inflight), 0);
  const queueDepth = ready.reduce((sum, runner) => sum + Math.max(0, runner.queueDepth), 0);
  const requestsPerSecond = ready.reduce((sum, runner) => sum + Math.max(0, runner.requestsPerSecond), 0);
  return calculatePoolCapacityFromTotals({
    totalRunners: runners.length, readyRunners: ready.length, totalConcurrency, inflight, queueDepth, requestsPerSecond,
    cpuUtilization: maximum(ready.map(runner => runner.cpuUtilization)),
    memoryUtilization: maximum(ready.map(runner => runner.memoryUtilization)),
    maxErrorRate: maximum(ready.map(runner => runner.errorRate)),
    weightedErrorNumerator: ready.reduce((sum, runner) => sum + Math.max(0, runner.errorRate) * Math.max(0, runner.requestsPerSecond), 0),
    worstRunnerLatencyP95Ms: maximum(ready.map(runner => runner.latencyP95Ms)),
  }, safeRpsPerRunner, predictedPeakRps, safetyFactor, minimumReplicas);
}

export type PoolCapacityTotals = {
  totalRunners: number; readyRunners: number; totalConcurrency: number; inflight: number; queueDepth: number;
  requestsPerSecond: number; cpuUtilization: number; memoryUtilization: number; maxErrorRate: number;
  weightedErrorNumerator: number; worstRunnerLatencyP95Ms: number;
};

/** SQL aggregates and in-memory runtime snapshots share the same capacity policy. */
export function calculatePoolCapacityFromTotals(totals: PoolCapacityTotals, safeRpsPerRunner: number,
  predictedPeakRps?: number, safetyFactor = 1.25, minimumReplicas = 1): PoolCapacity {
  const {totalConcurrency, inflight, queueDepth, requestsPerSecond} = totals;
  const concurrency = totalConcurrency > 0 ? inflight / totalConcurrency : 0;
  const cpu = totals.cpuUtilization;
  const memory = totals.memoryUtilization;
  const queue = queueDepth > 0 ? Math.min(1, queueDepth / Math.max(1, totals.readyRunners * 10)) : 0;
  const pressure = { concurrency, queue, cpu, memory };
  const [bottleneck, utilization] = Object.entries(pressure).reduce(
    (highest, candidate) => candidate[1] > highest[1] ? candidate : highest,
    ["concurrency", concurrency] as [keyof typeof pressure, number],
  );
  const degraded = totals.maxErrorRate >= 0.05;
  const status = totals.readyRunners === 0
    ? "offline"
    : degraded
      ? "degraded"
      : utilization >= 0.9 || queueDepth > totals.readyRunners * 10
        ? "saturated"
        : utilization >= 0.7
          ? "busy"
          : "ready";
  const demand = Math.max(requestsPerSecond, predictedPeakRps ?? 0);
  const safeRpsCapacity = totals.readyRunners * Math.max(0, safeRpsPerRunner);
  const rpsReplicas = safeRpsPerRunner > 0
    ? Math.ceil((demand * safetyFactor) / safeRpsPerRunner)
    : totals.readyRunners;
  const pressureReplicas = totals.readyRunners > 0
    ? Math.ceil(totals.readyRunners * Math.max(1, utilization * safetyFactor))
    : minimumReplicas;
  const queueReplicas = queueDepth > 0
    ? totals.readyRunners + Math.ceil(queueDepth / 10)
    : totals.readyRunners;
  const recommendedReplicas = Math.max(
    minimumReplicas,
    rpsReplicas,
    pressureReplicas,
    queueReplicas,
  );
  const aggregateErrorRate = requestsPerSecond > 0
    ? totals.weightedErrorNumerator / requestsPerSecond
    : totals.maxErrorRate;
  const worstRunnerLatencyP95Ms = totals.worstRunnerLatencyP95Ms;
  return {
    readyRunners: totals.readyRunners,
    totalRunners: totals.totalRunners,
    totalConcurrency,
    inflight,
    queueDepth,
    requestsPerSecond: round(requestsPerSecond),
    currentRps: round(requestsPerSecond),
    safeRpsCapacity: round(safeRpsCapacity),
    headroomRps: round(Math.max(0, safeRpsCapacity - requestsPerSecond)),
    utilization: round(Math.min(1, utilization)),
    inflightUtilization: round(Math.min(1, concurrency)),
    cpuUtilization: round(cpu),
    memoryUtilization: round(memory),
    errorRate: round(aggregateErrorRate),
    worstRunnerLatencyP95Ms: round(worstRunnerLatencyP95Ms),
    latencyP95Ms: round(worstRunnerLatencyP95Ms),
    status,
    recommendedReplicas,
    bottleneck: utilization === 0 ? "none" : bottleneck as keyof typeof pressure,
  };
}

function maximum(values: readonly number[]): number {
  return values.reduce((result, value) => Math.max(result, Math.max(0, value)), 0);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
