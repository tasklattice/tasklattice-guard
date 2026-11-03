import { z } from "zod";

export const tenantLoadLabTenantIds = ["tenantA", "tenantB", "tenantC"] as const;
const tenantId = z.enum(tenantLoadLabTenantIds);
const metric = z.number().finite().nonnegative();
const latency = metric.nullable();

export const tenantLoadLabControlSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("start") }),
  z.strictObject({ action: z.literal("stop") }),
  z.strictObject({ action: z.literal("reset") }),
  z.strictObject({ action: z.literal("peak"), tenantId, durationSeconds: z.union([z.literal(15), z.literal(30), z.literal(60)]).default(30) }),
  z.strictObject({ action: z.literal("release"), tenantId }),
  z.strictObject({ action: z.literal("mode"), mode: z.enum(["shared", "quota"]) }),
]);

const sample = z.object({
  occupancyPercent: metric, p95Ms: latency, guardP95Ms: latency,
  modelP95Ms: latency, completedRps: metric, queueP95Ms: latency,
});
const runnerMetrics = z.object({
  ready: z.boolean(), metricsAvailable: z.boolean(), inflight: metric, queue: metric, capacity: metric,
  cpuPercent: metric.optional(), memoryMiB: metric.optional(),
});

/** Only aggregate synthetic experiment data crosses the administrator proxy. */
export const tenantLoadLabStateSchema = z.object({
  running: z.boolean(), mode: z.enum(["shared", "quota"]), sampleIntervalMs: metric,
  fakeLlm: z.object({ fixedLatencyMs: metric, p95Ms: latency, active: metric, capacity: metric, completed: metric }),
  runner: z.object({
    ready: z.boolean(), inflight: metric, queue: metric, capacity: metric,
    cpuPercent: metric.optional(), memoryMiB: metric.optional(),
  }),
  groups: z.array(z.object({
    id: z.string().min(1).max(128), name: z.string().min(1).max(80),
    tenantIds: z.array(tenantId).min(1).max(3), poolIds: z.array(z.string().min(1).max(128)).min(1).max(3),
    runner: runnerMetrics,
  })).min(1).max(3),
  tenants: z.array(z.object({
    id: tenantId, name: z.string().max(80), color: z.string().max(32), slotBudget: metric,
    groupId: z.string().min(1).max(128), groupName: z.string().min(1).max(80), poolId: z.string().min(1).max(128),
    inflight: metric, queued: metric, offeredRps: metric, completedRps: metric,
    occupancyPercent: metric, p50Ms: latency, p95Ms: latency,
    guardP95Ms: latency, modelP95Ms: latency, queueP95Ms: latency,
    errors: metric, completed: metric, peakUntil: metric.nullable(),
    blocked: metric.default(0), inputBlocked: metric.default(0),
    outputBlocked: metric.default(0), transformed: metric.default(0),
  })).length(3),
  history: z.array(z.object({ time: metric, tenantA: sample, tenantB: sample, tenantC: sample,
    groups: z.record(z.string().min(1).max(128), runnerMetrics),
  })).max(180),
  events: z.array(z.object({
    id: z.string().max(128), time: metric, tenantId: tenantId.optional(),
    kind: z.string().max(40), message: z.string().max(1000),
  })).max(30),
  limits: z.object({ maxRps: metric, maxInflight: metric, queueLimit: metric }),
  measurement: z.object({
    occupancyDefinition: z.string().max(1000), quotaSimulation: z.boolean(), runnerMetricsAvailable: z.boolean(),
    runnerMetricsDefinition: z.string().max(1000),
  }),
});

export type TenantLoadLabControl = z.infer<typeof tenantLoadLabControlSchema>;
export type TenantLoadLabState = z.infer<typeof tenantLoadLabStateSchema>;
