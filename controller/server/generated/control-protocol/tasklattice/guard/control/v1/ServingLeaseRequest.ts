// Original file: runner_control.proto

import type { Long } from '@grpc/proto-loader';

/**
 * Optional experimental request. Its nonce must be unique within the boot and
 * locally timed from before sending. This message does not enable serving.
 */
export interface ServingLeaseRequest {
  'runnerId'?: (string);
  'bootId'?: (string);
  'nonce'?: (string);
  'epoch'?: (number | string | Long);
  /**
   * Exact applied desired-state generation challenged by this request.
   */
  'generation'?: (number | string | Long);
  'snapshotNonce'?: (string);
}

/**
 * Optional experimental request. Its nonce must be unique within the boot and
 * locally timed from before sending. This message does not enable serving.
 */
export interface ServingLeaseRequest__Output {
  'runnerId': (string);
  'bootId': (string);
  'nonce': (string);
  'epoch': (string);
  /**
   * Exact applied desired-state generation challenged by this request.
   */
  'generation': (string);
  'snapshotNonce': (string);
}
