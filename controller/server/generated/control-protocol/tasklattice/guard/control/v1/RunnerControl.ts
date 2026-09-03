// Original file: runner_control.proto

import type * as grpc from '@grpc/grpc-js'
import type { MethodDefinition } from '@grpc/proto-loader'
import type { ControllerMessage as _tasklattice_guard_control_v1_ControllerMessage, ControllerMessage__Output as _tasklattice_guard_control_v1_ControllerMessage__Output } from '../../../../tasklattice/guard/control/v1/ControllerMessage.js';
import type { RunnerMessage as _tasklattice_guard_control_v1_RunnerMessage, RunnerMessage__Output as _tasklattice_guard_control_v1_RunnerMessage__Output } from '../../../../tasklattice/guard/control/v1/RunnerMessage.js';

/**
 * RunnerControl is the only state-distribution channel between the control
 * plane and data plane. Every business payload is a typed imported message;
 * the stream envelope contains no embedded JSON documents.
 */
export interface RunnerControlClient extends grpc.Client {
  Connect(metadata: grpc.Metadata, options?: grpc.CallOptions): grpc.ClientDuplexStream<_tasklattice_guard_control_v1_RunnerMessage, _tasklattice_guard_control_v1_ControllerMessage__Output>;
  Connect(options?: grpc.CallOptions): grpc.ClientDuplexStream<_tasklattice_guard_control_v1_RunnerMessage, _tasklattice_guard_control_v1_ControllerMessage__Output>;
  connect(metadata: grpc.Metadata, options?: grpc.CallOptions): grpc.ClientDuplexStream<_tasklattice_guard_control_v1_RunnerMessage, _tasklattice_guard_control_v1_ControllerMessage__Output>;
  connect(options?: grpc.CallOptions): grpc.ClientDuplexStream<_tasklattice_guard_control_v1_RunnerMessage, _tasklattice_guard_control_v1_ControllerMessage__Output>;
  
}

/**
 * RunnerControl is the only state-distribution channel between the control
 * plane and data plane. Every business payload is a typed imported message;
 * the stream envelope contains no embedded JSON documents.
 */
export interface RunnerControlHandlers extends grpc.UntypedServiceImplementation {
  Connect: grpc.handleBidiStreamingCall<_tasklattice_guard_control_v1_RunnerMessage__Output, _tasklattice_guard_control_v1_ControllerMessage>;
  
}

export interface RunnerControlDefinition extends grpc.ServiceDefinition {
  Connect: MethodDefinition<_tasklattice_guard_control_v1_RunnerMessage, _tasklattice_guard_control_v1_ControllerMessage, _tasklattice_guard_control_v1_RunnerMessage__Output, _tasklattice_guard_control_v1_ControllerMessage__Output>
}
