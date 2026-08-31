// Original file: runner_control.proto

import type { Long } from '@grpc/proto-loader';

/**
 * ACK/NACK for verifying, prewarming, and activating an artifact generation.
 * A NACK preserves the Runner's last-known-good active generation.
 */
export interface ArtifactResult {
  'runnerId'?: (string);
  'artifactId'?: (string);
  /**
   * Desired-state generation whose artifact was verified and staged.
   */
  'generation'?: (number | string | Long);
  /**
   * True only after verification and prewarming have completed successfully.
   */
  'accepted'?: (boolean);
  /**
   * Human-readable NACK detail; empty for an ACK.
   */
  'reason'?: (string);
}

/**
 * ACK/NACK for verifying, prewarming, and activating an artifact generation.
 * A NACK preserves the Runner's last-known-good active generation.
 */
export interface ArtifactResult__Output {
  'runnerId': (string);
  'artifactId': (string);
  /**
   * Desired-state generation whose artifact was verified and staged.
   */
  'generation': (string);
  /**
   * True only after verification and prewarming have completed successfully.
   */
  'accepted': (boolean);
  /**
   * Human-readable NACK detail; empty for an ACK.
   */
  'reason': (string);
}
