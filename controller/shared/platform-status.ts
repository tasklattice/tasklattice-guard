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
  "default_guardrail_initializing",
  "default_guardrail_unavailable",
  "default_model_bindings_missing",
  "default_dependencies_unknown",
  "runner_heartbeat_stale",
] as const;
export type PlatformStatusReason = (typeof platformStatusReasons)[number];

export type ModelConfigurationStatus = "configured" | "unconfigured";
export type RuntimeModelStatus = ModelConfigurationStatus;
export type BasicProtectionStatus = "ready" | "initializing" | "unavailable";

/** Coverage of the published plan, never the editable draft or a preset name. */
export type ProtectionCoverage = {
  policyCount: number;
  inputChecks: number;
  outputChecks: number;
  requiredModelBindings: CapabilityBindingId[];
  hasUnknownDependencies: boolean;
};

export type BasicProtectionSnapshot = {
  status: BasicProtectionStatus;
  guardrailStatus: "active" | "initializing" | "unavailable";
  routerStatus: "active" | "initializing" | "unavailable";
  activeVersion: string | null;
  modelIndependent: boolean | null;
  coverage: ProtectionCoverage | null;
  draft: {
    revision: number;
    activeRevision: number | null;
    validationStatus: ValidationRunState | null;
    validationFailureReason: string | null;
  };
};

export type PlatformStatusSnapshot = {
  status: PlatformOperationalStatus;
  reasons: PlatformStatusReason[];
  observedAt: string;
  desiredGeneration: number;
  components: {
    controller: { status: "operational" };
    basicProtection: BasicProtectionSnapshot;
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
import type { CapabilityBindingId } from "./guardrail-catalog.js";
import type { ValidationRunState } from "./lifecycle.js";
