import type { SystemHealthSnapshot } from "../../shared/component-health.js";
import type { RunnerStatus } from "../../shared/lifecycle.js";

type RunnerHeartbeat = { status: RunnerStatus; lastHeartbeatAt: Date | null };

export function deriveComponentHealth(runners: readonly RunnerHeartbeat[] | null, evidence: {
  observedAt: Date;
  offlineAfterSeconds: number;
}): SystemHealthSnapshot {
  const observedAt = evidence.observedAt.toISOString();
  const heartbeatTimeoutSeconds = evidence.offlineAfterSeconds;
  // A failed store check is evidence about the Controller, not evidence that
  // every Runner is down. Never reuse an earlier successful fleet snapshot.
  if (runners === null) return {
    status: "unhealthy", observedAt,
    components: {
      controlPlane: { status: "unhealthy", reason: "storage_unavailable" },
      dataPlane: { status: "unknown", reason: "unknown", totalRunners: null,
        connectedRunners: null, unresponsiveRunners: null, heartbeatTimeoutSeconds },
    },
  };

  const cutoff = evidence.observedAt.getTime() - heartbeatTimeoutSeconds * 1_000;
  const stale = runners.filter(runner => !(runner.lastHeartbeatAt instanceof Date)
    || !Number.isFinite(runner.lastHeartbeatAt.getTime()) || runner.lastHeartbeatAt.getTime() <= cutoff);
  const connectedRunners = runners.filter(runner => runner.status !== "offline" && !stale.includes(runner)).length;
  const totalRunners = runners.length;
  const healthy = totalRunners > 0 && connectedRunners === totalRunners;
  return {
    status: healthy ? "healthy" : "unhealthy", observedAt,
    components: {
      controlPlane: { status: "healthy", reason: "responding" },
      dataPlane: {
        status: healthy ? "healthy" : "unhealthy",
        reason: !totalRunners ? "no_runners" : stale.length ? "heartbeat_timeout" : !healthy ? "disconnected" : "connected",
        totalRunners, connectedRunners, unresponsiveRunners: totalRunners - connectedRunners, heartbeatTimeoutSeconds,
      },
    },
  };
}
