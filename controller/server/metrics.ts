import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

import type { ControlPlaneService } from "./services/control-plane.js";

const durationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const poolStatuses = ["ready", "busy", "saturated", "degraded", "offline"] as const;
const pressureResources = ["concurrency", "queue", "cpu", "memory"] as const;
const servingRunnerStatuses = new Set(["ready", "busy", "saturated"]);

export class ControllerMetrics {
  readonly registry = new Registry();

  private readonly desiredGeneration: Gauge<string>;
  private readonly runnerInstances: Gauge<string>;
  private readonly desiredReplicas: Gauge<string>;
  private readonly readyReplicas: Gauge<string>;
  private readonly poolUtilization: Gauge<string>;
  private readonly poolRps: Gauge<string>;
  private readonly poolSafeRps: Gauge<string>;
  private readonly poolHeadroomRps: Gauge<string>;
  private readonly poolRecommendedReplicas: Gauge<string>;
  private readonly poolQueueDepth: Gauge<string>;
  private readonly poolErrorRate: Gauge<string>;
  private readonly poolWorstRunnerLatencyP95: Gauge<string>;
  private readonly poolStatus: Gauge<string>;
  private readonly poolBottleneck: Gauge<string>;
  private readonly runnerInfo: Gauge<string>;
  private readonly runnerAppliedGeneration: Gauge<string>;
  private readonly runnerGenerationLag: Gauge<string>;
  private readonly runnerHeartbeatAge: Gauge<string>;
  private readonly runnerTelemetryAge: Gauge<string>;
  private readonly outboxPending: Gauge<string>;
  private readonly outboxOldestAge: Gauge<string>;
  private readonly controlConnected: Gauge<string>;
  private readonly guardrailInfo: Gauge<string>;
  private readonly endpointInfo: Gauge<string>;
  private readonly guardrailEndpointInfo: Gauge<string>;
  private readonly guardrailRouterInfo: Gauge<string>;
  private readonly guardrailRouterReady: Gauge<string>;

  private readonly controlMessages: Counter<string>;
  private readonly heartbeats: Counter<string>;
  private readonly reconciliations: Counter<string>;
  private readonly reconciliationDuration: Histogram<string>;
  private readonly artifactDistribution: Counter<string>;
  private readonly jobs: Counter<string>;
  private readonly telemetryBatches: Counter<string>;
  private readonly telemetryEvents: Counter<string>;
  private readonly telemetryDeliveryLag: Histogram<string>;
  private readonly collectionFailures: Counter<string>;
  private readonly connectedByPool = new Map<string, number>();

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: "guard_controller_" });
    this.desiredGeneration = this.gauge(
      "guard_controller_desired_generation", "Current global desired-state generation.",
    );
    this.runnerInstances = this.gauge(
      "guard_controller_runner_instances", "Runner instances by pool and state.", ["pool", "status"],
    );
    this.desiredReplicas = this.gauge(
      "guard_controller_runner_desired_replicas", "Configured desired Runner replicas.", ["pool"],
    );
    this.readyReplicas = this.gauge(
      "guard_controller_runner_ready_replicas", "Runner replicas capable of serving last-known-good state.", ["pool"],
    );
    this.poolUtilization = this.gauge(
      "guard_controller_runner_pool_resource_utilization_ratio",
      "Runner pool pressure ratio by resource; queue is normalized against ten waiters per ready Runner.",
      ["pool", "resource"],
    );
    this.poolRps = this.gauge(
      "guard_controller_runner_pool_requests_per_second", "Observed request rate by Runner pool.", ["pool"],
    );
    this.poolSafeRps = this.gauge(
      "guard_controller_runner_pool_safe_requests_per_second",
      "Operator-configured safe request capacity by Runner pool.", ["pool"],
    );
    this.poolHeadroomRps = this.gauge(
      "guard_controller_runner_pool_headroom_requests_per_second",
      "Non-negative difference between configured safe capacity and observed request rate.", ["pool"],
    );
    this.poolRecommendedReplicas = this.gauge(
      "guard_controller_runner_pool_recommended_replicas",
      "Recommended replicas from RPS, pressure, and queue safety signals.", ["pool"],
    );
    this.poolQueueDepth = this.gauge(
      "guard_controller_runner_pool_admission_queue_depth",
      "Requests waiting for Guardrail runtime admission by pool.", ["pool"],
    );
    this.poolErrorRate = this.gauge(
      "guard_controller_runner_pool_execution_failure_ratio",
      "Request-rate-weighted Runner execution error and timeout ratio.",
      ["pool"],
    );
    this.poolWorstRunnerLatencyP95 = this.gauge(
      "guard_controller_runner_pool_worst_runner_latency_p95_seconds",
      "Highest heartbeat-window p95 among serving Runners; not a fleet-wide quantile.", ["pool"],
    );
    this.poolStatus = this.gauge(
      "guard_controller_runner_pool_status", "One-hot Runner pool status.", ["pool", "status"],
    );
    this.poolBottleneck = this.gauge(
      "guard_controller_runner_pool_bottleneck", "One-hot dominant pool pressure resource.",
      ["pool", "resource"],
    );
    this.runnerInfo = this.gauge(
      "guard_controller_runner_info",
      "Current registered Runner topology, including zero-traffic and offline instances.",
      ["runner_id", "pool", "status"],
    );
    this.runnerAppliedGeneration = this.gauge(
      "guard_controller_runner_applied_generation", "Applied generation reported by each Runner.",
      ["pool", "runner_id"],
    );
    this.runnerGenerationLag = this.gauge(
      "guard_controller_runner_generation_lag", "Desired generation minus applied generation by Runner.",
      ["pool", "runner_id"],
    );
    this.runnerHeartbeatAge = this.gauge(
      "guard_controller_runner_heartbeat_age_seconds", "Age of the latest Runner heartbeat.",
      ["pool", "runner_id"],
    );
    this.runnerTelemetryAge = this.gauge(
      "guard_controller_runner_telemetry_age_seconds",
      "Age of the latest telemetry batch or watermark; -1 means never observed.", ["pool", "runner_id"],
    );
    this.outboxPending = this.gauge(
      "guard_controller_outbox_pending", "Unprocessed Controller outbox records.", ["kind"],
    );
    this.outboxOldestAge = this.gauge(
      "guard_controller_outbox_oldest_age_seconds", "Age of the oldest unprocessed outbox record.", ["kind"],
    );
    this.controlConnected = this.gauge(
      "guard_controller_runner_control_connected", "Live Runner control streams by pool.", ["pool"],
    );
    this.guardrailInfo = this.gauge(
      "guard_controller_guardrail_info",
      "Current non-deleted Guardrail product topology. Status is the persisted Guardrail lifecycle state.",
      ["guardrail_id", "guardrail_name", "status"],
    );
    this.endpointInfo = this.gauge(
      "guard_controller_endpoint_info",
      "Current non-deleted Endpoint inventory, including valid Endpoints with no observed traffic.",
      ["endpoint_id", "endpoint_name", "adapter", "status"],
    );
    this.guardrailEndpointInfo = this.gauge(
      "guard_controller_guardrail_endpoint_info",
      "Configured Guardrail-to-Endpoint routing topology by Runner pool, independent of observed traffic.",
      ["guardrail_id", "endpoint_id", "endpoint_name", "pool", "status"],
    );
    this.guardrailRouterInfo = this.gauge(
      "guard_controller_guardrail_router_info",
      "Current Guardrail Router topology and bounded effective status: disabled, inactive, offline, syncing, degraded, or active.",
      ["guardrail_id", "guardrail_version", "router_id", "router_name", "pool", "status"],
    );
    this.guardrailRouterReady = this.gauge(
      "guard_controller_guardrail_router_ready",
      "Whether an active Guardrail Router has at least one serving Runner at the current desired generation.",
      ["guardrail_id", "router_id"],
    );

    this.controlMessages = this.counter(
      "guard_controller_runner_control_messages_total", "Control messages by direction, type, and result.",
      ["direction", "message_type", "result"],
    );
    this.heartbeats = this.counter(
      "guard_controller_runner_heartbeats_total", "Runner heartbeat processing attempts.", ["pool", "result"],
    );
    this.reconciliations = this.counter(
      "guard_controller_reconcile_total", "Runner desired-state reconciliation attempts.", ["pool", "result"],
    );
    this.reconciliationDuration = this.histogram(
      "guard_controller_reconcile_duration_seconds", "Desired-state reconciliation dispatch latency.",
      ["pool", "result"],
    );
    this.artifactDistribution = this.counter(
      "guard_controller_artifact_distribution_total", "Runner artifact application results.", ["pool", "result"],
    );
    this.jobs = this.counter(
      "guard_controller_jobs_total", "Compile and validation results received from Runner.", ["kind", "result"],
    );
    this.telemetryBatches = this.counter(
      "guard_controller_telemetry_batches_total", "Runner telemetry ingestion batches.", ["result"],
    );
    this.telemetryEvents = this.counter(
      "guard_controller_telemetry_events_total", "Runtime telemetry events offered to Controller ingestion.", ["result"],
    );
    this.telemetryDeliveryLag = this.histogram(
      "guard_controller_telemetry_delivery_lag_seconds", "Event occurred-to-received telemetry delay.",
      [], [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900, 3600],
    );
    this.collectionFailures = this.counter(
      "guard_controller_metrics_collection_failures_total", "Failures while collecting database-backed metrics.",
      ["stage"],
    );
  }

  async render(service: ControlPlaneService): Promise<string> {
    try {
      const [generation, pools, snapshot] = await Promise.all([
        service.desiredGeneration(),
        service.listRunnerPoolsWithCapacity(),
        service.observabilitySnapshot(),
      ]);
      const now = Date.now();
      const watermarkByRunner = new Map(snapshot.watermarks.map((item) => [item.runnerId, item]));
      const poolById = new Map(pools.map((pool) => [pool.id, pool]));
      this.desiredGeneration.set(generation);
      for (const metric of this.snapshotGauges()) metric.reset();
      for (const pool of pools) {
        const states = new Map<string, number>();
        for (const runner of pool.instances) states.set(runner.status, (states.get(runner.status) ?? 0) + 1);
        for (const [status, count] of states) this.runnerInstances.labels(pool.id, status).set(count);
        this.desiredReplicas.labels(pool.id).set(pool.desiredReplicas);
        this.readyReplicas.labels(pool.id).set(pool.capacity.readyRunners);
        const resources = {
          concurrency: pool.capacity.inflightUtilization,
          queue: pool.capacity.readyRunners > 0
            ? Math.min(1, pool.capacity.queueDepth / (pool.capacity.readyRunners * 10))
            : 0,
          cpu: pool.capacity.cpuUtilization,
          memory: pool.capacity.memoryUtilization,
        };
        for (const [resource, value] of Object.entries(resources)) {
          this.poolUtilization.labels(pool.id, resource).set(value);
        }
        this.poolRps.labels(pool.id).set(pool.capacity.currentRps);
        this.poolSafeRps.labels(pool.id).set(pool.capacity.safeRpsCapacity);
        this.poolHeadroomRps.labels(pool.id).set(pool.capacity.headroomRps);
        this.poolRecommendedReplicas.labels(pool.id).set(pool.capacity.recommendedReplicas);
        this.poolQueueDepth.labels(pool.id).set(pool.capacity.queueDepth);
        this.poolErrorRate.labels(pool.id).set(pool.capacity.errorRate);
        this.poolWorstRunnerLatencyP95.labels(pool.id).set(pool.capacity.worstRunnerLatencyP95Ms / 1_000);
        for (const status of poolStatuses) {
          this.poolStatus.labels(pool.id, status).set(Number(pool.capacity.status === status));
        }
        for (const resource of pressureResources) {
          this.poolBottleneck.labels(pool.id, resource).set(Number(pool.capacity.bottleneck === resource));
        }
        for (const runner of pool.instances) {
          this.runnerInfo.labels(runner.runnerId, pool.id, runner.status).set(1);
          this.runnerAppliedGeneration.labels(pool.id, runner.runnerId).set(runner.appliedGeneration);
          this.runnerGenerationLag.labels(pool.id, runner.runnerId).set(
            Math.max(0, runner.desiredGeneration - runner.appliedGeneration),
          );
          this.runnerHeartbeatAge.labels(pool.id, runner.runnerId).set(
            Math.max(0, (now - runner.lastHeartbeatAt.getTime()) / 1_000),
          );
          const watermark = watermarkByRunner.get(runner.runnerId);
          this.runnerTelemetryAge.labels(pool.id, runner.runnerId).set(
            watermark ? Math.max(0, (now - watermark.lastReceivedAt.getTime()) / 1_000) : -1,
          );
        }
      }
      for (const item of snapshot.pendingOutbox) {
        this.outboxPending.labels(item.kind).set(item.pending);
        this.outboxOldestAge.labels(item.kind).set(
          item.oldestCreatedAt ? Math.max(0, (now - item.oldestCreatedAt.getTime()) / 1_000) : 0,
        );
      }
      for (const guardrail of snapshot.guardrails) {
        this.guardrailInfo.labels(
          guardrail.guardrailId,
          guardrail.guardrailName,
          guardrail.status,
        ).set(1);
      }
      for (const endpoint of snapshot.endpoints) {
        this.endpointInfo.labels(
          endpoint.endpointId,
          endpoint.endpointName,
          endpoint.adapter,
          endpoint.status,
        ).set(1);
      }
      for (const binding of snapshot.endpointBindings) {
        this.guardrailEndpointInfo.labels(
          binding.guardrailId,
          binding.endpointId,
          binding.endpointName,
          binding.poolId,
          binding.status,
        ).set(1);
      }
      for (const router of snapshot.routers) {
        const pool = poolById.get(router.poolId);
        const hasServingRunner = pool?.instances.some((runner) => (
          servingRunnerStatuses.has(runner.status)
          && runner.appliedGeneration >= generation
        )) ?? false;
        const ready = router.status === "active" && hasServingRunner;
        const status = router.status !== "active"
          ? router.status
          : !pool || pool.capacity.readyRunners === 0
            ? "offline"
            : !hasServingRunner
              ? "syncing"
              : pool.capacity.status === "degraded"
                ? "degraded"
                : "active";
        this.guardrailRouterInfo.labels(
          router.guardrailId,
          router.guardrailVersion === null ? "unpublished" : String(router.guardrailVersion),
          router.routerId,
          router.routerName,
          router.poolId,
          status,
        ).set(1);
        this.guardrailRouterReady.labels(
          router.guardrailId,
          router.routerId,
        ).set(Number(ready));
      }
      return this.registry.metrics();
    } catch (error) {
      this.collectionFailures.labels("snapshot").inc();
      throw error;
    }
  }

  controlConnection(pool: string, connected: boolean): void {
    const next = Math.max(0, (this.connectedByPool.get(pool) ?? 0) + (connected ? 1 : -1));
    this.connectedByPool.set(pool, next);
    this.controlConnected.labels(pool).set(next);
  }

  observeControlMessage(direction: string, messageType: string, result = "success"): void {
    this.controlMessages.labels(direction, messageType || "unknown", result).inc();
  }

  observeHeartbeat(pool: string, result: string): void {
    this.heartbeats.labels(pool, result).inc();
  }

  observeReconcile(pool: string, result: string, durationSeconds: number): void {
    this.reconciliations.labels(pool, result).inc();
    this.reconciliationDuration.labels(pool, result).observe(Math.max(0, durationSeconds));
  }

  observeArtifactResult(pool: string, accepted: boolean): void {
    this.artifactDistribution.labels(pool, accepted ? "ack" : "nack").inc();
  }

  observeJob(kind: string, accepted: boolean): void {
    this.jobs.labels(kind, accepted ? "accepted" : "rejected").inc();
  }

  observeTelemetryBatch(result: string, occurredAt: readonly Date[], eventCount: number): void {
    this.telemetryBatches.labels(result).inc();
    if (eventCount > 0) this.telemetryEvents.labels(result).inc(eventCount);
    if (result === "accepted") {
      const now = Date.now();
      for (const timestamp of occurredAt) {
        this.telemetryDeliveryLag.observe(Math.max(0, (now - timestamp.getTime()) / 1_000));
      }
    }
  }

  private snapshotGauges(): Array<Gauge<string>> {
    return [
      this.runnerInstances, this.desiredReplicas, this.readyReplicas, this.poolUtilization,
      this.poolRps, this.poolSafeRps, this.poolHeadroomRps, this.poolRecommendedReplicas,
      this.poolQueueDepth, this.poolErrorRate, this.poolWorstRunnerLatencyP95,
      this.poolStatus, this.poolBottleneck, this.runnerInfo, this.runnerAppliedGeneration,
      this.runnerGenerationLag, this.runnerHeartbeatAge, this.runnerTelemetryAge,
      this.outboxPending, this.outboxOldestAge, this.guardrailInfo,
      this.endpointInfo, this.guardrailEndpointInfo,
      this.guardrailRouterInfo, this.guardrailRouterReady,
    ];
  }

  private gauge(name: string, help: string, labelNames: string[] = []): Gauge<string> {
    return new Gauge({ name, help, labelNames, registers: [this.registry] });
  }

  private counter(name: string, help: string, labelNames: string[]): Counter<string> {
    return new Counter({ name, help, labelNames, registers: [this.registry] });
  }

  private histogram(
    name: string,
    help: string,
    labelNames: string[],
    buckets: number[] = durationBuckets,
  ): Histogram<string> {
    return new Histogram({ name, help, labelNames, buckets, registers: [this.registry] });
  }
}
