/** Platform health includes component liveness and required model configuration. */
export type ComponentHealthStatus = "healthy" | "unhealthy" | "unknown";

export type PlatformModelHealth = {
  status: ComponentHealthStatus;
  reason: "not_required" | "configured" | "configuration_required" | "validation_required" | "unknown";
  bindings: Array<{ id: string; status: "missing" | "passed" | "failed" | "not_tested" }>;
};

export type SystemHealthSnapshot = {
  status: ComponentHealthStatus;
  observedAt: string;
  components: {
    models?: PlatformModelHealth;
    controlPlane: { status: "healthy" | "unhealthy"; reason: "responding" | "storage_unavailable" };
    dataPlane: {
      status: ComponentHealthStatus;
      reason: "connected" | "heartbeat_timeout" | "disconnected" | "no_runners" | "unknown";
      totalRunners: number | null;
      connectedRunners: number | null;
      unresponsiveRunners: number | null;
      heartbeatTimeoutSeconds: number;
    };
  };
};
