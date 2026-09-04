import { describe, expect, it } from "vitest";

import { deriveRunnerFleetStatus } from "./platform-status.js";

const runner = (status: "syncing" | "ready" | "busy" | "saturated" | "offline") => ({ status });

describe("deriveRunnerFleetStatus", () => {
  it("is unavailable when no Runner is connected", () => {
    expect(deriveRunnerFleetStatus({
      desiredReplicas: 2,
      instances: [runner("offline")],
      capacity: { readyRunners: 0, status: "offline" },
    })).toMatchObject({ status: "unavailable", reasons: ["no_connected_runners"] });
  });

  it("is initializing while connected Runners apply desired configuration", () => {
    expect(deriveRunnerFleetStatus({
      desiredReplicas: 2,
      instances: [runner("syncing"), runner("syncing")],
      capacity: { readyRunners: 0, status: "offline" },
    })).toMatchObject({ status: "initializing", reasons: ["runner_configuration_syncing"] });
  });

  it("is unavailable when connected Runners cannot serve traffic", () => {
    expect(deriveRunnerFleetStatus({
      desiredReplicas: 1,
      instances: [runner("ready")],
      capacity: { readyRunners: 0, status: "offline" },
    })).toMatchObject({ status: "unavailable", reasons: ["no_serving_runners"] });
  });

  it("is degraded but serving when capacity is below the desired replica count", () => {
    expect(deriveRunnerFleetStatus({
      desiredReplicas: 2,
      instances: [runner("ready"), runner("offline")],
      capacity: { readyRunners: 1, status: "ready" },
    })).toMatchObject({ status: "degraded", reasons: ["runner_capacity_below_desired"], servingRunners: 1 });
  });

  it("is degraded when a serving Runner is saturated", () => {
    expect(deriveRunnerFleetStatus({
      desiredReplicas: 1,
      instances: [runner("saturated")],
      capacity: { readyRunners: 1, status: "saturated" },
    })).toMatchObject({ status: "degraded", reasons: ["runner_saturated"] });
  });

  it("is healthy only when desired capacity is serving and converged", () => {
    expect(deriveRunnerFleetStatus({
      desiredReplicas: 2,
      instances: [runner("ready"), runner("busy")],
      capacity: { readyRunners: 2, status: "busy" },
    })).toMatchObject({
      status: "healthy",
      reasons: ["all_required_components_ready"],
      servingRunners: 2,
      connectedRunners: 2,
      convergedRunners: 2,
    });
  });
});
