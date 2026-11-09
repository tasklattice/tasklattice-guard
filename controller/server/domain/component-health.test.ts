import { describe, expect, it } from "vitest";
import { deriveComponentHealth } from "./component-health.js";

const now = new Date("2026-10-08T02:00:00Z");
const evidence = { observedAt: now, offlineAfterSeconds: 30 };
const live = { status: "ready" as const, lastHeartbeatAt: now };

describe("component health", () => {
  it("does not depend on policy assignment, configuration generation, or desired replica counts", () => {
    const result = deriveComponentHealth([live, { ...live, status: "syncing" }], evidence);
    expect(result.status).toBe("healthy");
    expect(result.components.dataPlane).toMatchObject({ status: "healthy", connectedRunners: 2, totalRunners: 2 });
  });
  it("reports a missing heartbeat even before the offline sweeper runs", () => {
    const result = deriveComponentHealth([live, { ...live, lastHeartbeatAt: new Date(now.getTime() - 31_000) }], evidence);
    expect(result.status).toBe("unhealthy");
    expect(result.components.controlPlane.status).toBe("healthy");
    expect(result.components.dataPlane).toMatchObject({ reason: "heartbeat_timeout", connectedRunners: 1, totalRunners: 2, unresponsiveRunners: 1 });
  });
  it.each([new Date(now.getTime() - 30_000), new Date(NaN), null])("does not accept an expired or invalid heartbeat (%s)", lastHeartbeatAt => {
    expect(deriveComponentHealth([{ ...live, lastHeartbeatAt }], evidence).status).toBe("unhealthy");
  });
  it("honors a disconnected stream even when its last heartbeat is recent", () => {
    expect(deriveComponentHealth([{ ...live, status: "offline" }], evidence).components.dataPlane)
      .toMatchObject({ status: "unhealthy", reason: "disconnected", connectedRunners: 0 });
  });
  it("does not report a healthy data plane with no registered Runners", () => {
    expect(deriveComponentHealth([], evidence)).toMatchObject({ status: "unhealthy", components: {
      controlPlane: { status: "healthy" }, dataPlane: { reason: "no_runners", totalRunners: 0 },
    } });
  });
  it("keeps Runner health unknown when the Controller's store check fails", () => {
    expect(deriveComponentHealth(null, evidence)).toMatchObject({ status: "unhealthy", components: {
      controlPlane: { status: "unhealthy", reason: "storage_unavailable" },
      dataPlane: { status: "unknown", connectedRunners: null, totalRunners: null },
    } });
  });
});
