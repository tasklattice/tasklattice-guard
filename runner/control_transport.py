"""Finite wire budget shared with Controller control-channel/transport.ts."""

CONTROL_MESSAGE_MAX_BYTES = 128 * 1024 * 1024
CONTROL_CHANNEL_OPTIONS = (
    ("grpc.max_receive_message_length", CONTROL_MESSAGE_MAX_BYTES),
    ("grpc.max_send_message_length", CONTROL_MESSAGE_MAX_BYTES),
)
