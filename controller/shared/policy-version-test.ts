import type { CapabilityBindingId } from "./guardrail-catalog.js";

export type PolicyTestEnvironment = {
  poolId: string;
  modelRevisionId: string;
  models: Array<{ binding: CapabilityBindingId; model: string; provider: string; profile: string; lowerThreshold: number; upperThreshold: number }>;
};
export type PolicyVersionTestSnapshot = {
  policyId: string; policyName: string; version: string;
  policyDigest: string; testSuiteDigest: string;
  parameters: Record<string, string>;
  environment: PolicyTestEnvironment;
};
export type PolicyTestBlocker = { code: string; message: string; binding?: CapabilityBindingId };
export type PolicyTestReadiness = {
  ready: boolean; blockers: PolicyTestBlocker[]; total: number;
  environment: PolicyTestEnvironment | null;
};
export type PolicyVersionTestRun = {
  id: string; policyId: string; version: string; status: string;
  total: number; passed: number; completed: number;
  failureReason: string | null; createdAt: string;
  snapshot: PolicyVersionTestSnapshot;
};
