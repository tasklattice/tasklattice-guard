import { z } from "zod";

export const admissionOutcomes = ["admitted", "queue_full", "queue_timeout", "rate_limited", "cancelled", "unavailable"] as const;
export const admissionBucketSeconds = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60] as const;
export const admissionSnapshotMaxBytes = 65_536;
export const admissionSnapshotMaxProjects = 64;
// This diagnostic ceiling keeps all bounded cross-source sums exactly integral.
const counter = z.number().int().nonnegative().max(10_000_000_000);
const gauge = z.number().int().nonnegative().max(1_000_000);
const identity = z.string().min(1).max(256).refine(value => value === value.trim());
const histogram = z.strictObject({ buckets: z.array(counter).length(admissionBucketSeconds.length + 1),
  count: counter, totalSeconds: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER) }).refine(value =>
  value.buckets.at(-1) === value.count && value.buckets.every((count, index) => index === 0 || count >= value.buckets[index - 1]!),
"Cumulative histogram buckets must be ordered and end at count.");
const project = z.strictObject({ projectId: identity, active: gauge, queued: gauge, limit: gauge.positive(),
  outcomes: z.strictObject({ admitted: counter, queue_full: counter, queue_timeout: counter, rate_limited: counter, cancelled: counter, unavailable: counter }),
  wait: histogram, held: histogram }).refine(value => value.active <= value.limit && value.wait.count === value.outcomes.admitted,
  "Admission gauges or admitted histogram are inconsistent.");

/** Internal heartbeat contract. No content, endpoint credentials or metrics URL. */
export const admissionSnapshotSchema = z.discriminatedUnion("available", [
  z.strictObject({ version: z.literal(1), available: z.literal(false), reason: z.enum(["disabled", "cardinality_limit", "payload_limit", "instrumentation_unavailable"]) }),
  z.strictObject({ version: z.literal(1), available: z.literal(true), capacity: gauge.positive(),
    monotonicSeconds: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER), projects: z.array(project).min(1).max(admissionSnapshotMaxProjects) })
    .refine(value => new Set(value.projects.map(row => row.projectId)).size === value.projects.length &&
      value.projects.reduce((sum, row) => sum + row.active, 0) <= value.capacity, "Duplicate projects or invalid total permit occupancy."),
]);
export type AdmissionSnapshot = z.infer<typeof admissionSnapshotSchema>;
export type AvailableAdmissionSnapshot = Extract<AdmissionSnapshot, { available: true }>;
export type AdmissionProjectSnapshot = AvailableAdmissionSnapshot["projects"][number];

const measured = z.number().finite().nonnegative().nullable();
export const admissionValuesSchema = z.object({ active: measured, queued: measured, capacity: measured, occupancyPercent: measured,
  attempts: measured, admitted: measured, rejected: measured, cancelled: measured,
  attemptsPerSecond: measured, admittedPerSecond: measured, rejectedPerSecond: measured,
  waitP95Ms: measured, heldP95Ms: measured });
export type AdmissionValues = z.infer<typeof admissionValuesSchema>;
const entity = z.object({ id: identity, name: z.string().max(256), groupId: identity,
  projectIds: z.array(identity).max(128), poolIds: z.array(identity).max(32),
  available: z.boolean(), intervalAvailable: z.boolean(), reason: z.string().max(80).nullable(),
  reportingSources: gauge, expectedSources: gauge, values: admissionValuesSchema,
  history: z.array(z.object({ at: z.number().finite().nonnegative(), values: admissionValuesSchema })).max(60) });
export const admissionMonitorStateSchema = z.object({ observedAt: z.number().finite().nonnegative(), source: z.literal("authenticated_runner_heartbeat"),
  controllerLocal: z.literal(true), staleAfterMs: gauge, available: z.boolean(), reason: z.string().max(80).nullable(),
  selectedPoolId: identity.nullable(), pools: z.array(z.object({ id: identity, name: z.string().max(256), groupId: identity })).max(32),
  groups: z.array(entity).max(32), projects: z.array(entity).max(128),
  sources: z.array(z.object({ runnerId: identity, poolId: identity, available: z.boolean(), reason: z.string().max(80).nullable(), ageMs: measured })).max(32),
});
export type AdmissionMonitorState = z.infer<typeof admissionMonitorStateSchema>;
export type AdmissionMonitorEntity = AdmissionMonitorState["groups"][number];
export const admissionMonitorQuerySchema = z.strictObject({ poolId: identity.optional() });
