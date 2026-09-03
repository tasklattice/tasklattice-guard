// Original file: enforcement_action.proto

/**
 * Closed post-evaluation directives shared by Controller and Runner. This is
 * not an evaluator verdict, a PolicyDecision, or a NeMo Action.
 * 
 * Declaration order is the stable product display order. Non-zero numeric
 * values are the canonical conflict priority: when independent evaluators
 * request different actions, the action with the greatest number wins.
 */
export const EnforcementAction = {
  /**
   * Omitted values are never interpreted as an explicit pass decision.
   */
  ENFORCEMENT_ACTION_UNSPECIFIED: 'ENFORCEMENT_ACTION_UNSPECIFIED',
  /**
   * Block the current phase. Do not call the model for rejected input or deliver rejected output.
   */
  ENFORCEMENT_ACTION_REJECT: 'ENFORCEMENT_ACTION_REJECT',
  /**
   * Mask sensitive spans with reviewed replacements and continue with the transformed content.
   */
  ENFORCEMENT_ACTION_REDACT: 'ENFORCEMENT_ACTION_REDACT',
  /**
   * Replace the current content with a complete reviewed replacement.
   */
  ENFORCEMENT_ACTION_REWRITE: 'ENFORCEMENT_ACTION_REWRITE',
  /**
   * Ask the owner of the model lifecycle to generate a new response.
   */
  ENFORCEMENT_ACTION_REGENERATE: 'ENFORCEMENT_ACTION_REGENERATE',
  /**
   * Guide the interaction to an approved topic, flow, or replacement response.
   */
  ENFORCEMENT_ACTION_REDIRECT: 'ENFORCEMENT_ACTION_REDIRECT',
  /**
   * Use an approved fallback response or degraded execution path.
   */
  ENFORCEMENT_ACTION_FALLBACK: 'ENFORCEMENT_ACTION_FALLBACK',
  /**
   * Require more information from the user before the interaction continues.
   */
  ENFORCEMENT_ACTION_CLARIFY: 'ENFORCEMENT_ACTION_CLARIFY',
  /**
   * Record the finding without intervening in the content.
   */
  ENFORCEMENT_ACTION_PASS: 'ENFORCEMENT_ACTION_PASS',
} as const;

/**
 * Closed post-evaluation directives shared by Controller and Runner. This is
 * not an evaluator verdict, a PolicyDecision, or a NeMo Action.
 * 
 * Declaration order is the stable product display order. Non-zero numeric
 * values are the canonical conflict priority: when independent evaluators
 * request different actions, the action with the greatest number wins.
 */
export type EnforcementAction =
  /**
   * Omitted values are never interpreted as an explicit pass decision.
   */
  | 'ENFORCEMENT_ACTION_UNSPECIFIED'
  | 0
  /**
   * Block the current phase. Do not call the model for rejected input or deliver rejected output.
   */
  | 'ENFORCEMENT_ACTION_REJECT'
  | 800
  /**
   * Mask sensitive spans with reviewed replacements and continue with the transformed content.
   */
  | 'ENFORCEMENT_ACTION_REDACT'
  | 200
  /**
   * Replace the current content with a complete reviewed replacement.
   */
  | 'ENFORCEMENT_ACTION_REWRITE'
  | 400
  /**
   * Ask the owner of the model lifecycle to generate a new response.
   */
  | 'ENFORCEMENT_ACTION_REGENERATE'
  | 500
  /**
   * Guide the interaction to an approved topic, flow, or replacement response.
   */
  | 'ENFORCEMENT_ACTION_REDIRECT'
  | 300
  /**
   * Use an approved fallback response or degraded execution path.
   */
  | 'ENFORCEMENT_ACTION_FALLBACK'
  | 600
  /**
   * Require more information from the user before the interaction continues.
   */
  | 'ENFORCEMENT_ACTION_CLARIFY'
  | 700
  /**
   * Record the finding without intervening in the content.
   */
  | 'ENFORCEMENT_ACTION_PASS'
  | 100

/**
 * Closed post-evaluation directives shared by Controller and Runner. This is
 * not an evaluator verdict, a PolicyDecision, or a NeMo Action.
 * 
 * Declaration order is the stable product display order. Non-zero numeric
 * values are the canonical conflict priority: when independent evaluators
 * request different actions, the action with the greatest number wins.
 */
export type EnforcementAction__Output = typeof EnforcementAction[keyof typeof EnforcementAction]
