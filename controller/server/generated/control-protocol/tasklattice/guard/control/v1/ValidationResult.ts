// Original file: validation.proto

import type { ValidationStatus as _tasklattice_guard_control_v1_ValidationStatus, ValidationStatus__Output as _tasklattice_guard_control_v1_ValidationStatus__Output } from '../../../../tasklattice/guard/control/v1/ValidationStatus.js';
import type { ValidationMetrics as _tasklattice_guard_control_v1_ValidationMetrics, ValidationMetrics__Output as _tasklattice_guard_control_v1_ValidationMetrics__Output } from '../../../../tasklattice/guard/control/v1/ValidationMetrics.js';
import type { ValidationCaseResult as _tasklattice_guard_control_v1_ValidationCaseResult, ValidationCaseResult__Output as _tasklattice_guard_control_v1_ValidationCaseResult__Output } from '../../../../tasklattice/guard/control/v1/ValidationCaseResult.js';

/**
 * Validation response. `accepted` reports whether the Runner executed the
 * command; `status` reports the business outcome of that executed run. Thus an
 * accepted result may legitimately have FAILED status. Rejected results carry
 * a reason and no meaningful metrics or case results.
 */
export interface ValidationResult {
  /**
   * Runner that executed or rejected the validation command.
   */
  'runnerId'?: (string);
  /**
   * Must exactly match the originating ValidationRequest.run_id.
   */
  'runId'?: (string);
  /**
   * True when execution completed and status/metrics/results are meaningful.
   */
  'accepted'?: (boolean);
  /**
   * Infrastructure rejection detail, or optional context for an executed run.
   */
  'reason'?: (string);
  /**
   * Business outcome; meaningful only when accepted is true.
   */
  'status'?: (_tasklattice_guard_control_v1_ValidationStatus);
  /**
   * Present and meaningful only when accepted is true.
   */
  'metrics'?: (_tasklattice_guard_control_v1_ValidationMetrics | null);
  /**
   * Per-case results; meaningful only when accepted is true.
   */
  'results'?: (_tasklattice_guard_control_v1_ValidationCaseResult)[];
}

/**
 * Validation response. `accepted` reports whether the Runner executed the
 * command; `status` reports the business outcome of that executed run. Thus an
 * accepted result may legitimately have FAILED status. Rejected results carry
 * a reason and no meaningful metrics or case results.
 */
export interface ValidationResult__Output {
  /**
   * Runner that executed or rejected the validation command.
   */
  'runnerId': (string);
  /**
   * Must exactly match the originating ValidationRequest.run_id.
   */
  'runId': (string);
  /**
   * True when execution completed and status/metrics/results are meaningful.
   */
  'accepted': (boolean);
  /**
   * Infrastructure rejection detail, or optional context for an executed run.
   */
  'reason': (string);
  /**
   * Business outcome; meaningful only when accepted is true.
   */
  'status': (_tasklattice_guard_control_v1_ValidationStatus__Output);
  /**
   * Present and meaningful only when accepted is true.
   */
  'metrics': (_tasklattice_guard_control_v1_ValidationMetrics__Output | null);
  /**
   * Per-case results; meaningful only when accepted is true.
   */
  'results': (_tasklattice_guard_control_v1_ValidationCaseResult__Output)[];
}
