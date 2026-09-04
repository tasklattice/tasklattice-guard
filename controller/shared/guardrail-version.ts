/**
 * Build the canonical Guardrail Version ID from an instant.
 *
 * The fixed-width UTC representation is both human-readable and
 * lexicographically sortable, so no separate numeric version exists.
 */
export function guardrailVersionId(value: Date | string = new Date()): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error("Guardrail Version requires a valid timestamp.");
  const part = (number: number, width = 2) => String(number).padStart(width, "0");
  return `${part(timestamp.getUTCFullYear(), 4)}${part(timestamp.getUTCMonth() + 1)}${part(timestamp.getUTCDate())}-${part(timestamp.getUTCHours())}${part(timestamp.getUTCMinutes())}${part(timestamp.getUTCSeconds())}.${part(timestamp.getUTCMilliseconds(), 3)}Z`;
}

export function isGuardrailVersionId(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{8}-\d{6}\.\d{3}Z$/.test(value)) return false;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.${value.slice(16, 19)}Z`;
  try {
    return guardrailVersionId(iso) === value;
  } catch {
    return false;
  }
}
