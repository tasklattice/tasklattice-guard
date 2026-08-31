// Original file: common.proto

/**
 * Runtime direction in which a Guardrail evaluates content.
 */
export const GuardrailPhase = {
  GUARDRAIL_PHASE_UNSPECIFIED: 'GUARDRAIL_PHASE_UNSPECIFIED',
  GUARDRAIL_PHASE_INPUT: 'GUARDRAIL_PHASE_INPUT',
  GUARDRAIL_PHASE_OUTPUT: 'GUARDRAIL_PHASE_OUTPUT',
} as const;

/**
 * Runtime direction in which a Guardrail evaluates content.
 */
export type GuardrailPhase =
  | 'GUARDRAIL_PHASE_UNSPECIFIED'
  | 0
  | 'GUARDRAIL_PHASE_INPUT'
  | 1
  | 'GUARDRAIL_PHASE_OUTPUT'
  | 2

/**
 * Runtime direction in which a Guardrail evaluates content.
 */
export type GuardrailPhase__Output = typeof GuardrailPhase[keyof typeof GuardrailPhase]
