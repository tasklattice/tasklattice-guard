/** Logical provenance budgets, separate from database disk/heap quotas. */
export type EndpointContextStorageLimits = Readonly<{
  maxRowsPerPool: number;
  maxRowsGlobal: number;
  maxPayloadBytesPerContext: number;
  maxPayloadBytesPerPool: number;
  maxPayloadBytesGlobal: number;
}>;

export const defaultEndpointContextStorageLimits: EndpointContextStorageLimits = Object.freeze({
  maxRowsPerPool: 256,
  maxRowsGlobal: 2048,
  maxPayloadBytesPerContext: 65_536,
  maxPayloadBytesPerPool: 16_777_216,
  maxPayloadBytesGlobal: 67_108_864,
});

export function validateEndpointContextStorageLimits(limits: EndpointContextStorageLimits): EndpointContextStorageLimits {
  const fields = Object.keys(defaultEndpointContextStorageLimits) as Array<keyof EndpointContextStorageLimits>;
  if (!limits || typeof limits !== "object" || Array.isArray(limits) || Object.keys(limits).length !== fields.length ||
      fields.some(field => !Number.isSafeInteger(limits[field]) || limits[field] < 1) ||
      limits.maxRowsPerPool > limits.maxRowsGlobal || limits.maxRowsGlobal > 1_000_000 ||
      limits.maxPayloadBytesPerContext > limits.maxPayloadBytesPerPool ||
      limits.maxPayloadBytesPerPool > limits.maxPayloadBytesGlobal || limits.maxPayloadBytesGlobal > 2_147_483_647) {
    throw new Error("Endpoint context storage limits must be positive bounded integers with context <= pool <= global budgets.");
  }
  return Object.freeze({ ...limits });
}
