export const platformOperationalStatuses = ["initializing", "healthy", "degraded", "unavailable"] as const;
export type PlatformOperationalStatus = (typeof platformOperationalStatuses)[number];

export const platformStatusReasons = [
  "all_required_components_ready",
  "runner_configuration_syncing",
  "runner_capacity_below_desired",
  "runner_saturated",
  "runner_errors",
  "no_serving_runners",
  "no_connected_runners",
] as const;
export type PlatformStatusReason = (typeof platformStatusReasons)[number];

export type ModelConfigurationStatus = "configured" | "unconfigured";
export type RuntimeModelStatus = "ready" | "unconfigured" | "unavailable";

export type PlatformStatusSnapshot = {
  status: PlatformOperationalStatus;
  reasons: PlatformStatusReason[];
  observedAt: string;
  desiredGeneration: number;
  components: {
    controller: { status: "operational" };
    runnerFleet: {
      status: PlatformOperationalStatus;
      servingRunners: number;
      desiredRunners: number;
      connectedRunners: number;
      totalRunners: number;
      convergedRunners: number;
      saturatedRunners: number;
    };
    controlPlaneModel: {
      status: ModelConfigurationStatus;
      provider: string | null;
      model: string | null;
    };
    runtimeModels: {
      status: RuntimeModelStatus;
      provider: string;
      models: ReadonlyArray<{ id: string; model: string }>;
    };
  };
};
