export const RUNTIME_LOG_CONTENT_RETENTION_DAYS = 30;

export const runtimeLogContentFields = [
  "contentCiphertext", "contentBefore", "contentAfter", "httpRequest", "modelExchanges",
] as const;

export function runtimeLogContentCutoff(): Date {
  return new Date(Date.now() - RUNTIME_LOG_CONTENT_RETENTION_DAYS * 86_400_000);
}

export function withoutRuntimeLogContent(metadata: Record<string, unknown>): Record<string, unknown> {
  const result = { ...metadata };
  for (const field of runtimeLogContentFields) delete result[field];
  return result;
}
