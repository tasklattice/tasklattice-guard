// Original file: runner_control.proto

import type { TrafficScope as _tasklattice_guard_control_v1_TrafficScope, TrafficScope__Output as _tasklattice_guard_control_v1_TrafficScope__Output } from '../../../../tasklattice/guard/control/v1/TrafficScope.js';

/**
 * Ordered traffic route from one Integration to one immutable artifact.
 */
export interface DeploymentRoute {
  'deploymentId'?: (string);
  'guardrailId'?: (string);
  'artifactId'?: (string);
  'integrationId'?: (string);
  /**
   * Ascending precedence within an Integration; the first matching route wins.
   */
  'routeOrder'?: (number);
  'trafficScope'?: (_tasklattice_guard_control_v1_TrafficScope | null);
}

/**
 * Ordered traffic route from one Integration to one immutable artifact.
 */
export interface DeploymentRoute__Output {
  'deploymentId': (string);
  'guardrailId': (string);
  'artifactId': (string);
  'integrationId': (string);
  /**
   * Ascending precedence within an Integration; the first matching route wins.
   */
  'routeOrder': (number);
  'trafficScope': (_tasklattice_guard_control_v1_TrafficScope__Output | null);
}
