/**
 * Canonical JSON shared by the Controller and Runner (`runner/protocol_codec.py`
 * `canonical_json`). Digests computed in either language must be identical, so
 * the encoding is deliberately narrow:
 *
 * - object keys are ASCII and sorted by code point;
 * - numbers are finite; integers must be safe, and fractional numbers must use
 *   plain decimal notation in both languages (|value| >= 1e-4);
 * - no whitespace; strings use JSON.stringify escaping (non-ASCII kept as-is).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return canonicalNumber(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") throw new TypeError("Canonical JSON arrays cannot contain undefined values.");
      return canonicalJson(item);
    }).join(",")}]`;
  }
  if (typeof value === "object") {
    const jsonable = value as { toJSON?: () => unknown };
    if (typeof jsonable.toJSON === "function") return canonicalJson(jsonable.toJSON());
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Canonical JSON accepts only plain objects.");
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    for (const [key] of entries) {
      if (!/^[\x20-\x7e]*$/.test(key)) throw new TypeError(`Canonical JSON keys must be printable ASCII: ${JSON.stringify(key)}.`);
    }
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`);
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("Canonical JSON numbers must be finite.");
  if (Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) throw new RangeError("Canonical JSON integers must be safe integers.");
    return String(value === 0 ? 0 : value);
  }
  if (Math.abs(value) < 1e-4) throw new RangeError("Canonical JSON fractional numbers must be at least 1e-4 in magnitude.");
  return JSON.stringify(value);
}
