import { describe, expect, it, vi } from "vitest";

import type { ControllerConfig } from "./config.js";
import type { ControllerDatabase } from "./db/client.js";
import { ControlPlaneService } from "./services/control-plane.js";
import { ControllerMetrics } from "./metrics.js";

describe("Controller metrics contract", () => {
  it("exports fleet convergence, freshness, capacity, and outbox signals", async () => {
    const now = Date.now();
    const service = {
      desiredGeneration: async () => 12,
      listRunnerPoolsWithCapacity: async () => [{
        id: "default",
        name: "GuardRails 0",
        isDefault: true,
        desiredReplicas: 2,
        safeRpsPerRunner: 50,
        maxConcurrencyPerRunner: 64,
        instances: [{
          runnerId: "runner-0",
          status: "ready",
          desiredGeneration: 12,
          appliedGeneration: 11,
          lastHeartbeatAt: new Date(now - 5_000),
        }],
        capacity: {
          readyRunners: 1,
          totalRunners: 1,
          totalConcurrency: 64,
          inflight: 16,
          queueDepth: 3,
          requestsPerSecond: 25,
          currentRps: 25,
          safeRpsCapacity: 50,
          headroomRps: 25,
          utilization: 0.25,
          inflightUtilization: 0.25,
          cpuUtilization: 0.2,
          memoryUtilization: 0.3,
          errorRate: 0.01,
          worstRunnerLatencyP95Ms: 120,
          latencyP95Ms: 120,
          status: "ready",
          recommendedReplicas: 2,
          bottleneck: "memory",
        },
      }],
      observabilitySnapshot: async () => ({
        watermarks: [{ runnerId: "runner-0", lastReceivedAt: new Date(now - 10_000) }],
        pendingOutbox: [{
          kind: "runner.desired_state_changed", pending: 2,
          oldestCreatedAt: new Date(now - 30_000),
        }],
        guardrails: [{
          guardrailId: "guardrail-1", guardrailName: "PII Shield",
          status: "active",
        }],
        endpoints: [{
          endpointId: "endpoint-1", endpointName: "Agent Gateway",
          adapter: "litellm-generic-guardrail", status: "active",
        }],
        endpointBindings: [{
          guardrailId: "guardrail-1", endpointId: "endpoint-1",
          endpointName: "Agent Gateway", poolId: "default", status: "active",
        }],
        routers: [{
          guardrailId: "guardrail-1", guardrailVersion: "20260904-030000.003Z",
          routerId: "router-1", routerName: "Production API",
          poolId: "default", status: "active",
        }],
      }),
    } as unknown as ControlPlaneService;
    const metrics = new ControllerMetrics();

    const rendered = await metrics.render(service);

    expect(rendered).toContain("guard_controller_desired_generation 12");
    expect(rendered).toContain('guard_controller_runner_info{runner_id="runner-0",pool="default",status="ready"} 1');
    expect(rendered).toContain('guard_controller_runner_generation_lag{pool="default",runner_id="runner-0"} 1');
    expect(rendered).toContain('guard_controller_runner_pool_resource_utilization_ratio{pool="default",resource="memory"} 0.3');
    expect(rendered).toContain('guard_controller_runner_pool_worst_runner_latency_p95_seconds{pool="default"} 0.12');
    expect(rendered).toContain('guard_controller_outbox_pending{kind="runner.desired_state_changed"} 2');
    expect(rendered).toContain('guard_controller_guardrail_info{guardrail_id="guardrail-1",guardrail_name="PII Shield",status="active"} 1');
    expect(rendered).toContain('guard_controller_endpoint_info{endpoint_id="endpoint-1",endpoint_name="Agent Gateway",adapter="litellm-generic-guardrail",status="active"} 1');
    expect(rendered).toContain('guard_controller_guardrail_endpoint_info{guardrail_id="guardrail-1",endpoint_id="endpoint-1",endpoint_name="Agent Gateway",pool="default",status="active"} 1');
    expect(rendered).toContain('guard_controller_guardrail_router_info{guardrail_id="guardrail-1",guardrail_version="20260904-030000.003Z",router_id="router-1",router_name="Production API",pool="default",status="syncing"} 1');
    expect(rendered).toContain('guard_controller_guardrail_router_ready{guardrail_id="guardrail-1",router_id="router-1"} 0');
  });

  it("marks an active Router ready only when its pool serves the desired generation", async () => {
    const service = {
      desiredGeneration: async () => 7,
      listRunnerPoolsWithCapacity: async () => [{
        id: "production", desiredReplicas: 2,
        instances: [{
          runnerId: "runner-ready", status: "ready", desiredGeneration: 7,
          appliedGeneration: 7, lastHeartbeatAt: new Date(),
        }],
        capacity: {
          readyRunners: 1, queueDepth: 0, inflightUtilization: 0,
          cpuUtilization: 0, memoryUtilization: 0, currentRps: 0,
          safeRpsCapacity: 50, headroomRps: 50, recommendedReplicas: 2,
          errorRate: 0, worstRunnerLatencyP95Ms: 0, status: "degraded",
          bottleneck: "none",
        },
      }],
      observabilitySnapshot: async () => ({
        watermarks: [], pendingOutbox: [],
        guardrails: [{
          guardrailId: "guardrail-1", guardrailName: "PII Shield",
          status: "active",
        }],
        endpoints: [], endpointBindings: [],
        routers: [{
          guardrailId: "guardrail-1", guardrailVersion: "20260904-030000.003Z",
          routerId: "router-1", routerName: "Production API",
          poolId: "production", status: "active",
        }],
      }),
    } as unknown as ControlPlaneService;

    const rendered = await new ControllerMetrics().render(service);

    expect(rendered).toContain('guard_controller_runner_info{runner_id="runner-ready",pool="production",status="ready"} 1');
    expect(rendered).toContain('guard_controller_guardrail_router_info{guardrail_id="guardrail-1",guardrail_version="20260904-030000.003Z",router_id="router-1",router_name="Production API",pool="production",status="degraded"} 1');
    expect(rendered).toContain('guard_controller_guardrail_router_ready{guardrail_id="guardrail-1",router_id="router-1"} 1');
  });

  it("records control, job, and telemetry counters", async () => {
    const metrics = new ControllerMetrics();
    metrics.controlConnection("default", true);
    metrics.observeHeartbeat("default", "accepted");
    metrics.observeArtifactResult("default", false);
    metrics.observeJob("compile", true);
    metrics.observeTelemetryBatch("accepted", [new Date()], 1);

    const rendered = await metrics.registry.metrics();
    expect(rendered).toContain('guard_controller_runner_control_connected{pool="default"} 1');
    expect(rendered).toContain('guard_controller_artifact_distribution_total{pool="default",result="nack"} 1');
    expect(rendered).toContain('guard_controller_telemetry_events_total{result="accepted"} 1');
  });

  it("removes stale database-backed series on the next scrape", async () => {
    let present = true;
    const service = {
      desiredGeneration: async () => 1,
      listRunnerPoolsWithCapacity: async () => present ? [{
        id: "default", desiredReplicas: 2,
        instances: [{
          runnerId: "runner-0", status: "ready", desiredGeneration: 1,
          appliedGeneration: 1, lastHeartbeatAt: new Date(),
        }],
        capacity: {
          readyRunners: 1, queueDepth: 0, inflightUtilization: 0,
          cpuUtilization: 0, memoryUtilization: 0, currentRps: 0,
          safeRpsCapacity: 50, headroomRps: 50, recommendedReplicas: 2,
          errorRate: 0, worstRunnerLatencyP95Ms: 0, status: "ready",
          bottleneck: "none",
        },
      }] : [],
      observabilitySnapshot: async () => ({
        watermarks: [], pendingOutbox: [],
        guardrails: present ? [{
          guardrailId: "guardrail-1", guardrailName: "PII Shield",
          status: "active",
        }] : [],
        endpoints: present ? [{
          endpointId: "endpoint-1", endpointName: "Agent Gateway",
          adapter: "litellm-generic-guardrail", status: "active",
        }] : [],
        endpointBindings: present ? [{
          guardrailId: "guardrail-1", endpointId: "endpoint-1",
          endpointName: "Agent Gateway", poolId: "default", status: "active",
        }] : [],
        routers: present ? [{
          guardrailId: "guardrail-1", guardrailVersion: "20260904-010000.001Z",
          routerId: "router-1", routerName: "Production API",
          poolId: "default", status: "active",
        }] : [],
      }),
    } as unknown as ControlPlaneService;
    const metrics = new ControllerMetrics();

    expect(await metrics.render(service)).toContain('runner_id="runner-0"');
    expect(await metrics.render(service)).toContain('guardrail_id="guardrail-1"');
    expect(await metrics.render(service)).toContain('endpoint_id="endpoint-1"');
    present = false;
    const rendered = await metrics.render(service);
    expect(rendered).not.toContain('runner_id="runner-0"');
    expect(rendered).not.toContain('guardrail_id="guardrail-1"');
    expect(rendered).not.toContain('endpoint_id="endpoint-1"');
  });

  it("converts persisted Guardrail topology into bounded observability states", async () => {
    const select = vi.fn()
      .mockImplementationOnce(() => ({
        from: vi.fn().mockResolvedValue([{ runnerId: "runner-0", lastReceivedAt: new Date() }]),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            groupBy: vi.fn().mockResolvedValue([{ kind: "test", pending: 1, oldestCreatedAt: null }]),
          })),
        })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([
            { id: "guardrail-1", name: "PII Shield", status: "active" },
            { id: "guardrail-2", name: "Draft Shield", status: "draft" },
          ]),
        })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([
            {
              id: "router-active", name: "Production API", activeRevision: 3,
              activeSnapshot: { routes: [
                { id: "r1", name: "Paused", kind: "normal", enabled: false, selector: { expression: { combinator: "and", conditions: [] } },
                  targets: [{ id: "t0", guardrailId: "guardrail-2", guardrailVersion: "20260904-020000.002Z", weightBps: 10000 }] },
                { id: "r2", name: "All", kind: "fallback", enabled: true, selector: { expression: { combinator: "and", conditions: [] } },
                  targets: [
                    { id: "t1", guardrailId: "guardrail-1", guardrailVersion: "20260904-030000.003Z", weightBps: 10000 },
                    { id: "t2", guardrailId: "guardrail-2", guardrailVersion: "20260904-020000.002Z", weightBps: 0 },
                  ] },
              ] },
            },
            { id: "router-unpublished", name: "Unpublished API", activeRevision: null, activeSnapshot: null },
            {
              id: "router-inactive", name: "Draft API", activeRevision: 1,
              activeSnapshot: { routes: [
                { id: "r3", name: "All", kind: "fallback", enabled: true, selector: { expression: { combinator: "and", conditions: [] } },
                  targets: [{ id: "t3", guardrailId: "guardrail-2", guardrailVersion: "20260904-020000.002Z", weightBps: 10000 }] },
              ] },
            },
          ]),
        })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn().mockResolvedValue([
          {
            id: "endpoint-active", name: "Agent Gateway", adapter: "litellm-generic-guardrail",
            status: "active", deletedAt: null, trafficRouterId: "router-active",
          },
          {
            id: "endpoint-disabled", name: "Disabled Gateway", adapter: "litellm-generic-guardrail",
            status: "disabled", deletedAt: null, trafficRouterId: "router-inactive",
          },
          {
            id: "endpoint-zero-traffic", name: "New Gateway", adapter: "openai-compatible",
            status: "active", deletedAt: null, trafficRouterId: null,
          },
          {
            id: "endpoint-deleted", name: "Deleted Gateway", adapter: "litellm-generic-guardrail",
            status: "disabled", deletedAt: new Date(), trafficRouterId: "router-active",
          },
        ]),
      }));
    const db = { select } as unknown as ControllerDatabase;

    const snapshot = await new ControlPlaneService(db, {} as ControllerConfig).observabilitySnapshot();

    expect(snapshot.guardrails).toEqual([
      { guardrailId: "guardrail-1", guardrailName: "PII Shield", status: "active" },
      { guardrailId: "guardrail-2", guardrailName: "Draft Shield", status: "draft" },
    ]);
    expect(snapshot.endpoints).toEqual([
      {
        endpointId: "endpoint-active", endpointName: "Agent Gateway",
        adapter: "litellm-generic-guardrail", status: "active",
      },
      {
        endpointId: "endpoint-disabled", endpointName: "Disabled Gateway",
        adapter: "litellm-generic-guardrail", status: "disabled",
      },
      {
        endpointId: "endpoint-zero-traffic", endpointName: "New Gateway",
        adapter: "openai-compatible", status: "active",
      },
    ]);
    // Disabled routes and zero-weight targets never become topology; deleted
    // Endpoints never become bindings; unpublished Routers have no topology.
    expect(snapshot.endpointBindings).toEqual([
      {
        guardrailId: "guardrail-1", endpointId: "endpoint-active",
        endpointName: "Agent Gateway", poolId: "default", status: "active",
      },
      {
        guardrailId: "guardrail-2", endpointId: "endpoint-disabled",
        endpointName: "Disabled Gateway", poolId: "default", status: "inactive",
      },
    ]);
    expect(snapshot.routers).toEqual([
      {
        guardrailId: "guardrail-1", guardrailVersion: "20260904-030000.003Z",
        routerId: "router-active", routerName: "Production API",
        poolId: "default", status: "active",
      },
      {
        guardrailId: "guardrail-2", guardrailVersion: "20260904-020000.002Z",
        routerId: "router-inactive", routerName: "Draft API",
        poolId: "default", status: "inactive",
      },
    ]);
  });
});
