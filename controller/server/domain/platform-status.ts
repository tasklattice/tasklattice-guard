import type { RunnerStatus } from "../../shared/lifecycle.js";
import type {
  PlatformOperationalStatus,
  PlatformStatusReason,
} from "../../shared/platform-status.js";

type RunnerPoolStatusInput = {
  desiredReplicas: number;
  instances: Array<{ status: RunnerStatus }>;
  capacity: {
    readyRunners: number;
    status: "ready" | "busy" | "saturated" | "degraded" | "offline";
  };
};

export type DerivedRunnerFleetStatus = {
  status: PlatformOperationalStatus;
  reasons: PlatformStatusReason[];
  servingRunners: number;
  desiredRunners: number;
  connectedRunners: number;
  totalRunners: number;
  convergedRunners: number;
  saturatedRunners: number;
};

export function deriveRunnerFleetStatus(pool?: RunnerPoolStatusInput): DerivedRunnerFleetStatus {
  const instances = pool?.instances ?? [];
  const connected = instances.filter((runner) => runner.status !== "offline");
  const converged = connected.filter((runner) => runner.status !== "syncing");
  const saturated = connected.filter((runner) => runner.status === "saturated");
  const servingRunners = pool?.capacity.readyRunners ?? 0;
  const desiredRunners = pool?.desiredReplicas ?? 0;

  const summary = {
    servingRunners,
    desiredRunners,
    connectedRunners: connected.length,
    totalRunners: instances.length,
    convergedRunners: converged.length,
    saturatedRunners: saturated.length,
  };

  if (connected.length === 0) {
    return { status: "unavailable", reasons: ["no_connected_runners"], ...summary };
  }
  if (servingRunners === 0 && connected.every((runner) => runner.status === "syncing")) {
    return { status: "initializing", reasons: ["runner_configuration_syncing"], ...summary };
  }
  if (servingRunners === 0) {
    return { status: "unavailable", reasons: ["no_serving_runners"], ...summary };
  }

  const reasons: PlatformStatusReason[] = [];
  if (servingRunners < desiredRunners) reasons.push("runner_capacity_below_desired");
  if (connected.some((runner) => runner.status === "syncing")) reasons.push("runner_configuration_syncing");
  if (saturated.length > 0 || pool?.capacity.status === "saturated") reasons.push("runner_saturated");
  if (pool?.capacity.status === "degraded") reasons.push("runner_errors");

  return reasons.length > 0
    ? { status: "degraded", reasons, ...summary }
    : { status: "healthy", reasons: ["all_required_components_ready"], ...summary };
}
