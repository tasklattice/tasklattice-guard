// Original file: routing.proto

import type { ComposedRoute as _tasklattice_guard_control_v1_ComposedRoute, ComposedRoute__Output as _tasklattice_guard_control_v1_ComposedRoute__Output } from '../../../../tasklattice/guard/control/v1/ComposedRoute.js';
import type { Long } from '@grpc/proto-loader';

/**
 * Immutable composed Router snapshot, shared by explicitly bound Endpoints.
 * This message is runtime configuration, NOT the Controller lifecycle state.
 * Controller derives unpublished/distributing/active/failed from the desired
 * generation, Runner acknowledgements, fresh heartbeats and rejection evidence.
 * See controller/shared/router-lifecycle.ts and docs/revision-lifecycle.zh-CN.md.
 * Historical deletion never edits this snapshot; active/in-flight revisions
 * must be retained. Rollback publishes a new Router revision, not an in-place edit.
 */
export interface RouterRevision {
  'routerId'?: (string);
  /**
   * Positive immutable Router revision, independent of desired generation.
   */
  'revision'?: (number | string | Long);
  /**
   * Published priority order, with exactly one unconditional fallback last.
   */
  'routes'?: (_tasklattice_guard_control_v1_ComposedRoute)[];
  /**
   * hmac-sha256-v1 hashes a JSON array of call identity, revision and Route ID.
   */
  'assignmentAlgorithm'?: (string);
  'assignmentKeyId'?: (string);
  /**
   * Secret HMAC key, at least 32 bytes; never exposed in telemetry.
   */
  'assignmentKey'?: (Buffer | Uint8Array | string);
}

/**
 * Immutable composed Router snapshot, shared by explicitly bound Endpoints.
 * This message is runtime configuration, NOT the Controller lifecycle state.
 * Controller derives unpublished/distributing/active/failed from the desired
 * generation, Runner acknowledgements, fresh heartbeats and rejection evidence.
 * See controller/shared/router-lifecycle.ts and docs/revision-lifecycle.zh-CN.md.
 * Historical deletion never edits this snapshot; active/in-flight revisions
 * must be retained. Rollback publishes a new Router revision, not an in-place edit.
 */
export interface RouterRevision__Output {
  'routerId': (string);
  /**
   * Positive immutable Router revision, independent of desired generation.
   */
  'revision': (string);
  /**
   * Published priority order, with exactly one unconditional fallback last.
   */
  'routes': (_tasklattice_guard_control_v1_ComposedRoute__Output)[];
  /**
   * hmac-sha256-v1 hashes a JSON array of call identity, revision and Route ID.
   */
  'assignmentAlgorithm': (string);
  'assignmentKeyId': (string);
  /**
   * Secret HMAC key, at least 32 bytes; never exposed in telemetry.
   */
  'assignmentKey': (Buffer);
}
