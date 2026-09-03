// Original file: common.proto

/**
 * Coordinator decision after evaluating one step of the execution route.
 */
export const RouteDecision = {
  ROUTE_DECISION_UNSPECIFIED: 'ROUTE_DECISION_UNSPECIFIED',
  ROUTE_DECISION_COMPLETE: 'ROUTE_DECISION_COMPLETE',
  ROUTE_DECISION_ENFORCE: 'ROUTE_DECISION_ENFORCE',
  ROUTE_DECISION_ESCALATE: 'ROUTE_DECISION_ESCALATE',
  ROUTE_DECISION_FAIL_OPEN: 'ROUTE_DECISION_FAIL_OPEN',
  ROUTE_DECISION_FAIL_CLOSED: 'ROUTE_DECISION_FAIL_CLOSED',
} as const;

/**
 * Coordinator decision after evaluating one step of the execution route.
 */
export type RouteDecision =
  | 'ROUTE_DECISION_UNSPECIFIED'
  | 0
  | 'ROUTE_DECISION_COMPLETE'
  | 1
  | 'ROUTE_DECISION_ENFORCE'
  | 2
  | 'ROUTE_DECISION_ESCALATE'
  | 3
  | 'ROUTE_DECISION_FAIL_OPEN'
  | 4
  | 'ROUTE_DECISION_FAIL_CLOSED'
  | 5

/**
 * Coordinator decision after evaluating one step of the execution route.
 */
export type RouteDecision__Output = typeof RouteDecision[keyof typeof RouteDecision]
