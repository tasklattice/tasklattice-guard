import { admissionBucketSeconds, admissionSnapshotMaxProjects } from "../../shared/admission-monitor.js";
import type { ProjectAdmissionHistogram__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/ProjectAdmissionHistogram.js";
import type { ProjectAdmissionSnapshot__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/ProjectAdmissionSnapshot.js";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const integer = (value: string | undefined) => value === undefined ? undefined : Number(value);

/** Preserve scalar presence while adapting the typed wire to the monitor's
 * strict bounded schema. Invalid input cannot become a zero observation. */
export function admissionSnapshotBytesFromWire(value: ProjectAdmissionSnapshot__Output | null | undefined): Uint8Array | undefined {
  if (!value) return undefined;
  const invalid = () => encode({});
  if (value.available === false) {
    if (value.capacity !== undefined || value.monotonicSeconds !== undefined || value.projects.length || (value.reason?.length ?? 0) > 80) return invalid();
    return encode({ version: value.version, available: false, reason: value.reason });
  }
  if (value.available !== true || value.reason !== undefined) return invalid();
  if (value.projects.length > admissionSnapshotMaxProjects) return encode({ version: 1, available: false, reason: "cardinality_limit" });
  if (value.projects.some(row => row.projectId.length > 256 || [row.wait, row.held].some(histogram =>
    histogram && histogram.buckets.length > admissionBucketSeconds.length + 1))) return invalid();
  const histogram = (row: ProjectAdmissionHistogram__Output | null) => row ? {
    buckets: row.buckets.map(Number), count: integer(row.count), totalSeconds: row.totalSeconds,
  } : undefined;
  return encode({ version: value.version, available: true, capacity: value.capacity, monotonicSeconds: value.monotonicSeconds,
    projects: value.projects.map(row => ({ projectId: row.projectId, active: row.active, queued: row.queued, limit: row.limit,
      outcomes: row.outcomes ? { admitted: integer(row.outcomes.admitted), queue_full: integer(row.outcomes.queueFull),
        queue_timeout: integer(row.outcomes.queueTimeout), rate_limited: integer(row.outcomes.rateLimited),
        cancelled: integer(row.outcomes.cancelled), unavailable: integer(row.outcomes.unavailable) } : undefined,
      wait: histogram(row.wait), held: histogram(row.held),
    })),
  });
}
