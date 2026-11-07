// Full validation traces and signed desired state exceed gRPC's 4 MiB default.
// Keep a finite, symmetric budget; mirrored in runner/control_transport.py.
export const CONTROL_MESSAGE_MAX_BYTES = 128 * 1024 * 1024;
export const controlChannelOptions = {
  "grpc.max_receive_message_length": CONTROL_MESSAGE_MAX_BYTES,
  "grpc.max_send_message_length": CONTROL_MESSAGE_MAX_BYTES,
};
