// Original file: common.proto

/**
 * Buffering contract that controls when evaluated model output may be delivered.
 */
export const OutputDeliveryMode = {
  OUTPUT_DELIVERY_MODE_UNSPECIFIED: 'OUTPUT_DELIVERY_MODE_UNSPECIFIED',
  OUTPUT_DELIVERY_MODE_INTERRUPTIBLE: 'OUTPUT_DELIVERY_MODE_INTERRUPTIBLE',
  OUTPUT_DELIVERY_MODE_WINDOW_BUFFERED: 'OUTPUT_DELIVERY_MODE_WINDOW_BUFFERED',
  OUTPUT_DELIVERY_MODE_FULL_BUFFERED: 'OUTPUT_DELIVERY_MODE_FULL_BUFFERED',
} as const;

/**
 * Buffering contract that controls when evaluated model output may be delivered.
 */
export type OutputDeliveryMode =
  | 'OUTPUT_DELIVERY_MODE_UNSPECIFIED'
  | 0
  | 'OUTPUT_DELIVERY_MODE_INTERRUPTIBLE'
  | 1
  | 'OUTPUT_DELIVERY_MODE_WINDOW_BUFFERED'
  | 2
  | 'OUTPUT_DELIVERY_MODE_FULL_BUFFERED'
  | 3

/**
 * Buffering contract that controls when evaluated model output may be delivered.
 */
export type OutputDeliveryMode__Output = typeof OutputDeliveryMode[keyof typeof OutputDeliveryMode]
