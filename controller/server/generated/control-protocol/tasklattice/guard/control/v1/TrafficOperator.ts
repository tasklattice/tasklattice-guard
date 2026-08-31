// Original file: routing.proto

/**
 * Comparison operation supported by Runner traffic selection.
 */
export const TrafficOperator = {
  TRAFFIC_OPERATOR_UNSPECIFIED: 'TRAFFIC_OPERATOR_UNSPECIFIED',
  TRAFFIC_OPERATOR_EQUALS: 'TRAFFIC_OPERATOR_EQUALS',
  TRAFFIC_OPERATOR_CONTAINS: 'TRAFFIC_OPERATOR_CONTAINS',
  TRAFFIC_OPERATOR_STARTS_WITH: 'TRAFFIC_OPERATOR_STARTS_WITH',
  TRAFFIC_OPERATOR_GLOB: 'TRAFFIC_OPERATOR_GLOB',
} as const;

/**
 * Comparison operation supported by Runner traffic selection.
 */
export type TrafficOperator =
  | 'TRAFFIC_OPERATOR_UNSPECIFIED'
  | 0
  | 'TRAFFIC_OPERATOR_EQUALS'
  | 1
  | 'TRAFFIC_OPERATOR_CONTAINS'
  | 2
  | 'TRAFFIC_OPERATOR_STARTS_WITH'
  | 3
  | 'TRAFFIC_OPERATOR_GLOB'
  | 4

/**
 * Comparison operation supported by Runner traffic selection.
 */
export type TrafficOperator__Output = typeof TrafficOperator[keyof typeof TrafficOperator]
