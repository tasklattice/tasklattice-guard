import { describe, expect, it } from "vitest";

import { calculatePoolCapacity } from "./capacity.js";

describe("Runner pool capacity", () => {
  it("combines heartbeat load into scaling signals", () => {
    const result = calculatePoolCapacity([
      { status: "ready", inflight: 32, maxConcurrency: 64, queueDepth: 0, cpuUtilization: 0.5, memoryUtilization: 0.4, requestsPerSecond: 40, errorRate: 0.01, latencyP95Ms: 90 },
      { status: "busy", inflight: 48, maxConcurrency: 64, queueDepth: 2, cpuUtilization: 0.75, memoryUtilization: 0.6, requestsPerSecond: 45, errorRate: 0.02, latencyP95Ms: 120 },
    ], 50, 130);

    expect(result.readyRunners).toBe(2);
    expect(result.currentRps).toBe(85);
    expect(result.safeRpsCapacity).toBe(100);
    expect(result.inflightUtilization).toBe(0.625);
    expect(result.utilization).toBe(0.75);
    expect(result.errorRate).toBe(0.0153);
    expect(result.worstRunnerLatencyP95Ms).toBe(120);
    expect(result.latencyP95Ms).toBe(120);
    expect(result.recommendedReplicas).toBe(4);
  });

  it("recommends one replica when a pool has no load", () => {
    const result = calculatePoolCapacity([], 50, 0);

    expect(result.recommendedReplicas).toBe(1);
  });
});
