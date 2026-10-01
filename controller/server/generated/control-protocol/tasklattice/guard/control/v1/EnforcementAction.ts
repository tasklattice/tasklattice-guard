// Original file: enforcement_action.proto

/**
 * Closed Rule handling decisions shared by Controller and Runner. Detector
 * implementation and application workflows are separate from these decisions.
 * Declaration order is display order; the greatest numeric priority wins.
 */
export const EnforcementAction = {
  /**
   * Missing values are not an explicit allow decision.
   */
  ENFORCEMENT_ACTION_UNSPECIFIED: 'ENFORCEMENT_ACTION_UNSPECIFIED',
  /**
   * Keep the content unchanged and record evidence; never override another Rule's block.
   */
  ENFORCEMENT_ACTION_ALLOW: 'ENFORCEMENT_ACTION_ALLOW',
  /**
   * Stop the checked content. The caller owns refusal presentation and any subsequent workflow.
   */
  ENFORCEMENT_ACTION_BLOCK: 'ENFORCEMENT_ACTION_BLOCK',
  /**
   * Continue only with a concrete replacement or valid content patches; missing output fails closed.
   */
  ENFORCEMENT_ACTION_TRANSFORM: 'ENFORCEMENT_ACTION_TRANSFORM',
} as const;

/**
 * Closed Rule handling decisions shared by Controller and Runner. Detector
 * implementation and application workflows are separate from these decisions.
 * Declaration order is display order; the greatest numeric priority wins.
 */
export type EnforcementAction =
  /**
   * Missing values are not an explicit allow decision.
   */
  | 'ENFORCEMENT_ACTION_UNSPECIFIED'
  | 0
  /**
   * Keep the content unchanged and record evidence; never override another Rule's block.
   */
  | 'ENFORCEMENT_ACTION_ALLOW'
  | 100
  /**
   * Stop the checked content. The caller owns refusal presentation and any subsequent workflow.
   */
  | 'ENFORCEMENT_ACTION_BLOCK'
  | 800
  /**
   * Continue only with a concrete replacement or valid content patches; missing output fails closed.
   */
  | 'ENFORCEMENT_ACTION_TRANSFORM'
  | 200

/**
 * Closed Rule handling decisions shared by Controller and Runner. Detector
 * implementation and application workflows are separate from these decisions.
 * Declaration order is display order; the greatest numeric priority wins.
 */
export type EnforcementAction__Output = typeof EnforcementAction[keyof typeof EnforcementAction]
