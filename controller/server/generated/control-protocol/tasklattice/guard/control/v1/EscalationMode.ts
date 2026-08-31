// Original file: common.proto

/**
 * Policy for invoking a deeper evaluator after an earlier result.
 */
export const EscalationMode = {
  ESCALATION_MODE_UNSPECIFIED: 'ESCALATION_MODE_UNSPECIFIED',
  ESCALATION_MODE_NEVER: 'ESCALATION_MODE_NEVER',
  ESCALATION_MODE_ON_UNCERTAIN: 'ESCALATION_MODE_ON_UNCERTAIN',
  ESCALATION_MODE_ALWAYS: 'ESCALATION_MODE_ALWAYS',
} as const;

/**
 * Policy for invoking a deeper evaluator after an earlier result.
 */
export type EscalationMode =
  | 'ESCALATION_MODE_UNSPECIFIED'
  | 0
  | 'ESCALATION_MODE_NEVER'
  | 1
  | 'ESCALATION_MODE_ON_UNCERTAIN'
  | 2
  | 'ESCALATION_MODE_ALWAYS'
  | 3

/**
 * Policy for invoking a deeper evaluator after an earlier result.
 */
export type EscalationMode__Output = typeof EscalationMode[keyof typeof EscalationMode]
