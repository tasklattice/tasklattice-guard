// Original file: validation.proto

/**
 * Coarse execution stage reported while a validation run is in progress.
 */
export const ValidationExecutionPhase = {
  VALIDATION_EXECUTION_PHASE_UNSPECIFIED: 'VALIDATION_EXECUTION_PHASE_UNSPECIFIED',
  VALIDATION_EXECUTION_PHASE_PREPARING: 'VALIDATION_EXECUTION_PHASE_PREPARING',
  VALIDATION_EXECUTION_PHASE_EXECUTING: 'VALIDATION_EXECUTION_PHASE_EXECUTING',
  VALIDATION_EXECUTION_PHASE_FINALIZING: 'VALIDATION_EXECUTION_PHASE_FINALIZING',
} as const;

/**
 * Coarse execution stage reported while a validation run is in progress.
 */
export type ValidationExecutionPhase =
  | 'VALIDATION_EXECUTION_PHASE_UNSPECIFIED'
  | 0
  | 'VALIDATION_EXECUTION_PHASE_PREPARING'
  | 1
  | 'VALIDATION_EXECUTION_PHASE_EXECUTING'
  | 2
  | 'VALIDATION_EXECUTION_PHASE_FINALIZING'
  | 3

/**
 * Coarse execution stage reported while a validation run is in progress.
 */
export type ValidationExecutionPhase__Output = typeof ValidationExecutionPhase[keyof typeof ValidationExecutionPhase]
