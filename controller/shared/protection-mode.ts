export const protectionModes = ["enforce", "monitor", "bypass"] as const;
export type ProtectionMode = (typeof protectionModes)[number];
export type GuardrailProtectionStatus = "not_ready" | ProtectionMode;
export const PROTECTION_MODE_CAPABILITY = "tasklattice.protection-modes";

export type ProtectionModeSettings = {
  guardrailId: string;
  mode: ProtectionMode;
  appliedMode: ProtectionMode;
  generation: number;
  ready: boolean;
  status: "applied" | "applying" | "partial" | "failed" | "waiting";
  applied: number;
  total: number;
  runners: Array<{ runnerId: string; modeApplied: boolean; status: "applied" | "pending" | "offline" | "unsupported" | "failed"; reason: string | null }>;
  updatedAt: string | null;
  updatedBy: string | null;
  reason: string;
};

/** Environment-local operating settings never travel inside an immutable version. */
export const resetProtectionMode = {
  protectionMode: "enforce" as const,
  protectionModeApplied: "enforce" as const,
  protectionModeUpdatedAt: null,
  protectionModeUpdatedBy: null,
  protectionModeReason: "",
};
