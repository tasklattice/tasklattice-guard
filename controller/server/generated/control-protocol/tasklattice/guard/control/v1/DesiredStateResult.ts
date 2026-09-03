// Original file: runner_control.proto

import type { Long } from '@grpc/proto-loader';

/**
 * ACK/NACK for the complete atomic desired-state generation. A NACK keeps the
 * prior artifacts, routes, integrations, and model Provider registry active.
 */
export interface DesiredStateResult {
  'runnerId'?: (string);
  /**
   * Complete desired-state generation that was either applied or rejected.
   */
  'generation'?: (number | string | Long);
  /**
   * True only after the full generation has been prewarmed and swapped in.
   */
  'accepted'?: (boolean);
  /**
   * Human-readable NACK detail; empty for an ACK.
   */
  'reason'?: (string);
  'modelRevisionId'?: (string);
}

/**
 * ACK/NACK for the complete atomic desired-state generation. A NACK keeps the
 * prior artifacts, routes, integrations, and model Provider registry active.
 */
export interface DesiredStateResult__Output {
  'runnerId': (string);
  /**
   * Complete desired-state generation that was either applied or rejected.
   */
  'generation': (string);
  /**
   * True only after the full generation has been prewarmed and swapped in.
   */
  'accepted': (boolean);
  /**
   * Human-readable NACK detail; empty for an ACK.
   */
  'reason': (string);
  'modelRevisionId': (string);
}
