// Original file: runner_control.proto

import type { Long } from '@grpc/proto-loader';

/**
 * Delta counters and point-in-time pressure measurements for a fixed interval.
 */
export interface RunnerLoad {
  /**
   * Aggregate requests currently holding admission slots across active
   * Guardrail runtimes. This is not the HTTP socket/in-flight count.
   */
  'inflight'?: (number);
  /**
   * Admission-slot denominator used with inflight; must be greater than zero.
   */
  'maxConcurrency'?: (number);
  /**
   * Requests waiting for an admission slot at observation time.
   */
  'queueDepth'?: (number);
  /**
   * Requests completed during observation_interval_ms; resets each interval.
   */
  'requestsDelta'?: (number | string | Long);
  /**
   * Technical errors during observation_interval_ms; policy blocks are excluded.
   */
  'errorsDelta'?: (number | string | Long);
  /**
   * Request timeouts during observation_interval_ms.
   */
  'timeoutsDelta'?: (number | string | Long);
  /**
   * Request latency p95 in milliseconds for this observation interval.
   */
  'latencyP95Ms'?: (number | string);
  /**
   * Process CPU utilization ratio in [0, 1].
   */
  'cpuUtilization'?: (number | string);
  /**
   * Process memory utilization ratio in [0, 1].
   */
  'memoryUtilization'?: (number | string);
  'activeGuardrails'?: (number);
  'compileQueueDepth'?: (number);
  /**
   * Exact duration in milliseconds covered by the delta counters.
   */
  'observationIntervalMs'?: (number | string | Long);
}

/**
 * Delta counters and point-in-time pressure measurements for a fixed interval.
 */
export interface RunnerLoad__Output {
  /**
   * Aggregate requests currently holding admission slots across active
   * Guardrail runtimes. This is not the HTTP socket/in-flight count.
   */
  'inflight': (number);
  /**
   * Admission-slot denominator used with inflight; must be greater than zero.
   */
  'maxConcurrency': (number);
  /**
   * Requests waiting for an admission slot at observation time.
   */
  'queueDepth': (number);
  /**
   * Requests completed during observation_interval_ms; resets each interval.
   */
  'requestsDelta': (string);
  /**
   * Technical errors during observation_interval_ms; policy blocks are excluded.
   */
  'errorsDelta': (string);
  /**
   * Request timeouts during observation_interval_ms.
   */
  'timeoutsDelta': (string);
  /**
   * Request latency p95 in milliseconds for this observation interval.
   */
  'latencyP95Ms': (number);
  /**
   * Process CPU utilization ratio in [0, 1].
   */
  'cpuUtilization': (number);
  /**
   * Process memory utilization ratio in [0, 1].
   */
  'memoryUtilization': (number);
  'activeGuardrails': (number);
  'compileQueueDepth': (number);
  /**
   * Exact duration in milliseconds covered by the delta counters.
   */
  'observationIntervalMs': (string);
}
