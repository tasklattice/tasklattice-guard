import { requestController } from "./controller-api";

export type LabTenantId = "tenantA" | "tenantB" | "tenantC";
export type LabMode = "shared" | "quota";
export type LabMetric = {
  occupancyPercent: number;
  p95Ms: number | null;
  guardP95Ms: number | null;
  modelP95Ms: number | null;
  queueP95Ms: number | null;
  completedRps: number;
};
export type LabGroupRunner = {
  ready: boolean;
  metricsAvailable: boolean;
  inflight: number;
  queue: number;
  capacity: number;
  cpuPercent?: number | null;
  memoryMiB?: number | null;
};
export type LabGroup = { id: string; name: string; tenantIds: LabTenantId[]; poolIds: string[]; runner: LabGroupRunner };
export type LabSample = { time: number; groups?: Record<string, LabGroupRunner> } & Record<LabTenantId, LabMetric>;
export type LabTenant = LabMetric & {
  id: LabTenantId;
  name: string;
  color: string;
  groupId: string;
  groupName: string;
  poolId: string;
  slotBudget: number;
  inflight: number;
  queued: number;
  offeredRps: number;
  p50Ms: number | null;
  blocked?: number;
  inputBlocked?: number;
  outputBlocked?: number;
  transformed?: number;
  errors: number;
  completed: number;
  peakUntil: number | null;
};
export type LabEvent = { id: string; time: number; tenantId?: LabTenantId; kind: string; message: string };
export type TenantLoadLabState = {
  running: boolean;
  mode: LabMode;
  sampleIntervalMs: number;
  fakeLlm: { fixedLatencyMs: number; p95Ms: number | null; active: number; capacity: number; completed: number };
  runner: { ready: boolean; inflight: number; queue: number; capacity: number; cpuPercent?: number | null; memoryMiB?: number | null };
  tenants: LabTenant[];
  groups: LabGroup[];
  history: LabSample[];
  events: LabEvent[];
  limits: { maxRps: number; maxInflight: number; queueLimit: number };
  measurement: { occupancyDefinition: string; quotaSimulation: boolean; runnerMetricsAvailable?: boolean; runnerMetricsDefinition?: string };
};
export type LabControl = {
  action: "start" | "stop" | "reset" | "peak" | "release" | "mode";
  tenantId?: LabTenantId;
  mode?: LabMode;
  durationSeconds?: number;
};

export const tenantLoadLabKey = ["resources", "tenant-load-lab"] as const;
export const getTenantLoadLabState = (signal?: AbortSignal) =>
  requestController<TenantLoadLabState>("/api/v1/tenant-load-lab/state", { signal });
export const controlTenantLoadLab = (input: LabControl) =>
  requestController<TenantLoadLabState>("/api/v1/tenant-load-lab/control", {
    method: "POST", body: JSON.stringify(input),
  });
