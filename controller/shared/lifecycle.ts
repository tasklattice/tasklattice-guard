/**
 * Controller-owned state vocabulary.
 *
 * These values are not part of the Controller/Runner wire protocol. Proto is
 * the sole cross-process contract; this module is the sole TypeScript contract
 * for Controller persistence, HTTP DTOs, and UI projections.
 */

/** Persisted lifecycle of a Guardrail resource. `disabled` is terminal after soft deletion. */
export const guardrailLifecycleStates = ["draft", "active", "disabled"] as const;
export type GuardrailLifecycleState = (typeof guardrailLifecycleStates)[number];

/** Persisted lifecycle of one immutable Guardrail version. */
export const guardrailVersionStates = ["compiling", "ready", "failed"] as const;
export type GuardrailVersionState = (typeof guardrailVersionStates)[number];

/** Persisted lifecycle shared by Guardrail and programmable-policy validation runs. */
export const validationRunStates = ["queued", "running", "passed", "failed"] as const;
export type ValidationRunState = (typeof validationRunStates)[number];
export type ValidationTerminalState = Extract<ValidationRunState, "passed" | "failed">;

/** UI projection used when no persisted validation run exists yet. */
export type ValidationRunDisplayState = "not_run" | ValidationRunState;

/** Reversible enabled state of an Endpoint that has not been soft-deleted. */
export const endpointLifecycleStates = ["active", "disabled"] as const;
export type EndpointLifecycleState = (typeof endpointLifecycleStates)[number];

/** Setup progress shown by the Endpoint UI; it is not the persisted Endpoint lifecycle. */
export const endpointSetupStates = ["applying", "awaiting_callback", "verified", "disabled"] as const;
export type EndpointSetupState = (typeof endpointSetupStates)[number];

/**
 * Derived Guardrail readiness shown in the UI. This is deliberately not a
 * resource lifecycle: it is recomputed from the current draft, active version,
 * and enabled router count.
 */
export const guardrailReadinessStates = ["needs_validation", "ready", "protected"] as const;
export type GuardrailReadinessState = (typeof guardrailReadinessStates)[number];

/** Runner reconciliation/connectivity axis before it is folded into `RunnerStatus`. */
export const runnerReconciliationStates = ["syncing", "synchronized", "offline"] as const;
export type RunnerReconciliationState = (typeof runnerReconciliationStates)[number];

/** Runner pressure axis, meaningful only while the Runner is synchronized. */
export const runnerPressureStates = ["ready", "busy", "saturated"] as const;
export type RunnerPressureState = (typeof runnerPressureStates)[number];

/**
 * Persisted/API projection of Runner reconciliation and pressure. `syncing`
 * and `offline` represent the reconciliation axis; the three pressure values
 * imply `synchronized`. Registration itself is an event, not a durable state.
 */
export const runnerStatuses = ["syncing", "ready", "busy", "saturated", "offline"] as const;
export type RunnerStatus = (typeof runnerStatuses)[number];

/** Allowed persisted transitions; omitted self-transitions do not change state. */
export const guardrailLifecycleTransitions = {
  draft: ["active", "disabled"],
  active: ["disabled"],
  disabled: [],
} as const satisfies Record<GuardrailLifecycleState, readonly GuardrailLifecycleState[]>;

/** Guardrail versions are immutable once compilation reaches a terminal state. */
export const guardrailVersionTransitions = {
  compiling: ["ready", "failed"],
  ready: [],
  failed: [],
} as const satisfies Record<GuardrailVersionState, readonly GuardrailVersionState[]>;

/**
 * A result may complete a queued run directly if it races the best-effort
 * `running` update; dispatch failures also complete a queued run as failed.
 */
export const validationRunTransitions = {
  queued: ["running", "passed", "failed"],
  running: ["passed", "failed"],
  passed: [],
  failed: [],
} as const satisfies Record<ValidationRunState, readonly ValidationRunState[]>;

/** Disabling an Endpoint is reversible until the separate soft-delete overlay is set. */
export const endpointLifecycleTransitions = {
  active: ["disabled"],
  disabled: ["active"],
} as const satisfies Record<EndpointLifecycleState, readonly EndpointLifecycleState[]>;
