// Original file: runner_control.proto

import type { Long } from '@grpc/proto-loader';

/**
 * Process identity and capabilities announced once when opening a stream.
 */
export interface RunnerRegistration {
  /**
   * Stable logical instance identifier, normally derived from StatefulSet identity.
   */
  'runnerId'?: (string);
  /**
   * Unique process-start identifier used to reject messages from an older boot.
   */
  'bootId'?: (string);
  /**
   * Logical Runner pool whose desired state this stream receives.
   */
  'poolId'?: (string);
  'runnerVersion'?: (string);
  /**
   * NeMo Guardrails runtime version loaded by this process.
   */
  'nemoVersion'?: (string);
  /**
   * Admission-slot capacity advertised by this Runner; must be greater than zero.
   */
  'maxConcurrency'?: (number);
  /**
   * True only when the Runner may execute CompileRequest and ValidationRequest.
   */
  'compilerCapable'?: (boolean);
  'labels'?: ({[key: string]: string});
  /**
   * Last atomically activated desired-state generation, or zero before first sync.
   */
  'appliedGeneration'?: (number | string | Long);
}

/**
 * Process identity and capabilities announced once when opening a stream.
 */
export interface RunnerRegistration__Output {
  /**
   * Stable logical instance identifier, normally derived from StatefulSet identity.
   */
  'runnerId': (string);
  /**
   * Unique process-start identifier used to reject messages from an older boot.
   */
  'bootId': (string);
  /**
   * Logical Runner pool whose desired state this stream receives.
   */
  'poolId': (string);
  'runnerVersion': (string);
  /**
   * NeMo Guardrails runtime version loaded by this process.
   */
  'nemoVersion': (string);
  /**
   * Admission-slot capacity advertised by this Runner; must be greater than zero.
   */
  'maxConcurrency': (number);
  /**
   * True only when the Runner may execute CompileRequest and ValidationRequest.
   */
  'compilerCapable': (boolean);
  'labels': ({[key: string]: string});
  /**
   * Last atomically activated desired-state generation, or zero before first sync.
   */
  'appliedGeneration': (string);
}
