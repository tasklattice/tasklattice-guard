/** Component liveness, independent of Guardrail publication or assignment. */
export type ComponentHealthStatus = "healthy" | "unhealthy" | "unknown";

export type SystemHealthSnapshot = {
  status: ComponentHealthStatus;
  observedAt: string;
  components: {
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
