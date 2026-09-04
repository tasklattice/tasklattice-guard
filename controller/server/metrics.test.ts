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
          status: "active", activeVersion: "20260904-030000.003Z",
        }],
        integrations: [{
          integrationId: "integration-1", integrationName: "Agent Gateway",
          adapter: "generic-http-guard", status: "active",
        }],
        integrationBindings: [{
          guardrailId: "guardrail-1", integrationId: "integration-1",
          integrationName: "Agent Gateway", poolId: "default", status: "active",
        }],
        deployments: [{
          guardrailId: "guardrail-1", guardrailVersion: "20260904-030000.003Z",
          deploymentId: "deployment-1", deploymentName: "Production API",
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
    expect(rendered).toContain('guard_controller_integration_info{integration_id="integration-1",integration_name="Agent Gateway",adapter="generic-http-guard",status="active"} 1');
    expect(rendered).toContain('guard_controller_guardrail_integration_info{guardrail_id="guardrail-1",integration_id="integration-1",integration_name="Agent Gateway",pool="default",status="active"} 1');
    expect(rendered).toContain('guard_controller_guardrail_deployment_info{guardrail_id="guardrail-1",guardrail_version="20260904-030000.003Z",deployment_id="deployment-1",deployment_name="Production API",pool="default",status="syncing"} 1');
    expect(rendered).toContain('guard_controller_guardrail_deployment_ready{guardrail_id="guardrail-1",deployment_id="deployment-1"} 0');
  });

  it("marks an active Deployment ready only when its pool serves the desired generation", async () => {
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
          status: "active", activeVersion: "20260904-030000.003Z",
        }],
        integrations: [], integrationBindings: [],
        deployments: [{
          guardrailId: "guardrail-1", guardrailVersion: "20260904-030000.003Z",
          deploymentId: "deployment-1", deploymentName: "Production API",
          poolId: "production", status: "active",
        }],
      }),
    } as unknown as ControlPlaneService;

    const rendered = await new ControllerMetrics().render(service);

    expect(rendered).toContain('guard_controller_runner_info{runner_id="runner-ready",pool="production",status="ready"} 1');
    expect(rendered).toContain('guard_controller_guardrail_deployment_info{guardrail_id="guardrail-1",guardrail_version="20260904-030000.003Z",deployment_id="deployment-1",deployment_name="Production API",pool="production",status="degraded"} 1');
    expect(rendered).toContain('guard_controller_guardrail_deployment_ready{guardrail_id="guardrail-1",deployment_id="deployment-1"} 1');
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
          status: "active", activeVersion: "20260904-010000.001Z",
        }] : [],
        integrations: present ? [{
          integrationId: "integration-1", integrationName: "Agent Gateway",
          adapter: "generic-http-guard", status: "active",
        }] : [],
        integrationBindings: present ? [{
          guardrailId: "guardrail-1", integrationId: "integration-1",
          integrationName: "Agent Gateway", poolId: "default", status: "active",
        }] : [],
        deployments: present ? [{
          guardrailId: "guardrail-1", guardrailVersion: "20260904-010000.001Z",
          deploymentId: "deployment-1", deploymentName: "Production API",
          poolId: "default", status: "active",
        }] : [],
      }),
    } as unknown as ControlPlaneService;
    const metrics = new ControllerMetrics();

    expect(await metrics.render(service)).toContain('runner_id="runner-0"');
    expect(await metrics.render(service)).toContain('guardrail_id="guardrail-1"');
    expect(await metrics.render(service)).toContain('integration_id="integration-1"');
    present = false;
    const rendered = await metrics.render(service);
    expect(rendered).not.toContain('runner_id="runner-0"');
    expect(rendered).not.toContain('guardrail_id="guardrail-1"');
    expect(rendered).not.toContain('integration_id="integration-1"');
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
            { id: "guardrail-1", name: "PII Shield", status: "active", activeVersion: "20260904-030000.003Z" },
            { id: "guardrail-2", name: "Draft Shield", status: "draft", activeVersion: null },
          ]),
        })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([
            {
              id: "deployment-active", name: "Production API", guardrailId: "guardrail-1",
              guardrailVersion: null, integrationId: "integration-active", poolId: "production", enabled: true,
            },
            {
              id: "deployment-disabled", name: "Disabled API", guardrailId: "guardrail-1",
              guardrailVersion: "20260904-020000.002Z", integrationId: "integration-active", poolId: "production", enabled: false,
            },
            {
              id: "deployment-inactive", name: "Draft API", guardrailId: "guardrail-2",
              guardrailVersion: null, integrationId: "integration-disabled", poolId: "production", enabled: true,
            },
          ]),
        })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn().mockResolvedValue([
          {
            id: "integration-active", name: "Agent Gateway", adapter: "generic-http-guard",
            status: "active", deletedAt: null,
          },
          {
            id: "integration-disabled", name: "Disabled Gateway", adapter: "generic-http-guard",
            status: "disabled", deletedAt: null,
          },
          {
            id: "integration-zero-traffic", name: "New Gateway", adapter: "openai-compatible",
            status: "active", deletedAt: null,
          },
          {
            id: "integration-deleted", name: "Deleted Gateway", adapter: "generic-http-guard",
            status: "disabled", deletedAt: new Date(),
          },
        ]),
      }));
    const db = { select } as unknown as ControllerDatabase;

    const snapshot = await new ControlPlaneService(db, {} as ControllerConfig).observabilitySnapshot();

    expect(snapshot.guardrails).toEqual([
      { guardrailId: "guardrail-1", guardrailName: "PII Shield", status: "active", activeVersion: "20260904-030000.003Z" },
      { guardrailId: "guardrail-2", guardrailName: "Draft Shield", status: "draft", activeVersion: null },
    ]);
    expect(snapshot.integrations).toEqual([
      {
        integrationId: "integration-active", integrationName: "Agent Gateway",
        adapter: "generic-http-guard", status: "active",
      },
      {
        integrationId: "integration-disabled", integrationName: "Disabled Gateway",
        adapter: "generic-http-guard", status: "disabled",
      },
      {
        integrationId: "integration-zero-traffic", integrationName: "New Gateway",
        adapter: "openai-compatible", status: "active",
      },
    ]);
    expect(snapshot.integrationBindings).toEqual([
      {
        guardrailId: "guardrail-1", integrationId: "integration-active",
        integrationName: "Agent Gateway", poolId: "production", status: "active",
      },
      {
        guardrailId: "guardrail-2", integrationId: "integration-disabled",
        integrationName: "Disabled Gateway", poolId: "production", status: "inactive",
      },
    ]);
    expect(snapshot.deployments).toEqual([
      {
        guardrailId: "guardrail-1", guardrailVersion: "20260904-030000.003Z",
        deploymentId: "deployment-active", deploymentName: "Production API",
        poolId: "production", status: "active",
      },
      {
        guardrailId: "guardrail-1", guardrailVersion: "20260904-020000.002Z",
        deploymentId: "deployment-disabled", deploymentName: "Disabled API",
        poolId: "production", status: "disabled",
      },
      {
        guardrailId: "guardrail-2", guardrailVersion: null,
        deploymentId: "deployment-inactive", deploymentName: "Draft API",
        poolId: "production", status: "inactive",
      },
    ]);
  });
});
