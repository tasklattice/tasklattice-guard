import { ControllerError } from "../domain/errors.js";

const defaults = Object.freeze({ maxBytes: 8 * 1024 * 1024, timeoutMs: 10_000, maxDepth: 64, maxStructuralTokens: 100_000 });
type ReadLimits = Partial<typeof defaults>;

/** Acquire only after authentication. No waiting uploads retain bodies/queues.
 * The permit covers bounded reading, parsing and the event transaction. */
export class TelemetryUploadAdmission {
  private inflight = 0;
  private readonly pools = new Map<string, number>();
  constructor(private readonly capacity = 4, private readonly perPool = 2) {
    if (!Number.isSafeInteger(capacity) || !Number.isSafeInteger(perPool) || perPool < 1 || capacity < perPool)
      throw new Error("Telemetry upload concurrency budgets are invalid.");
  }
  acquire(poolId: string): Readonly<{ release(): void }> {
    if (this.inflight >= this.capacity || (this.pools.get(poolId) ?? 0) >= this.perPool)
      throw new ControllerError("Telemetry upload capacity is unavailable. Retry with the retained batch.", 503,
        "telemetry_upload_capacity_unavailable", { retryAfterSeconds: 1 });
    this.inflight++;
    this.pools.set(poolId, (this.pools.get(poolId) ?? 0) + 1);
    let released = false;
    return Object.freeze({ release: () => {
      if (released) return;
      released = true;
      this.inflight--;
      const remaining = this.pools.get(poolId)! - 1;
      if (remaining) this.pools.set(poolId, remaining); else this.pools.delete(poolId);
    } });
  }
}

/** Always count the actual stream, including when Content-Length is supplied.
 * A fixed buffer bounds memory even for millions of tiny chunks. This is a
 * per-upload input budget, not a whole-controller heap/disk/latency guarantee. */
export async function readBoundedTelemetryBody(request: Request, options: ReadLimits = {}): Promise<string> {
  const limits = { ...defaults, ...options };
  if (Object.keys(options).some(key => !(key in defaults)) ||
      (Object.keys(defaults) as Array<keyof typeof defaults>).some(key =>
        !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > defaults[key]))
    throw new Error("Telemetry body budgets must be positive integers within the server defaults.");
  const declared = request.headers.get("content-length");
  if (declared !== null && !/^\d+$/.test(declared)) { cancelBody(request); throw invalid(); }
  if (declared !== null && Number(declared) > limits.maxBytes) { cancelBody(request); throw tooLarge(); }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const bytes = new Uint8Array(limits.maxBytes);
  let size = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ControllerError("Telemetry upload read deadline elapsed.", 408, "telemetry_upload_timeout")), limits.timeoutMs);
  });
  try {
    // Only one reaction subscribes to the deadline. A per-chunk race retains
    // deadline reactions proportional to chunk count despite the byte bound.
    const consume = async () => {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (stopped || done) return;
        if (!(value instanceof Uint8Array)) throw invalid();
        if (value.byteLength > limits.maxBytes - size) throw tooLarge();
        bytes.set(value, size);
        size += value.byteLength;
      }
    };
    await Promise.race([consume(), deadline]);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)); }
    catch { throw invalid(); }
    checkComplexity(text, limits.maxDepth, limits.maxStructuralTokens);
    return text;
  } catch (error) {
    stopped = true;
    // Never wait on an untrusted stream's cancel promise before returning the
    // error/releasing admission. The reader already stopped retaining input.
    try { void reader.cancel().catch(() => {}); } catch {}
    throw error;
  } finally {
    clearTimeout(timer!);
    try { reader.releaseLock(); } catch {}
  }
}

function checkComplexity(text: string, maxDepth: number, maxTokens: number): void {
  let quoted = false, escaped = false, depth = 0, tokens = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      if (++depth > maxDepth || ++tokens > maxTokens) throw tooLarge();
    } else if (char === "}" || char === "]") {
      if (--depth < 0) throw invalid();
      if (++tokens > maxTokens) throw tooLarge();
    } else if ((char === "," || char === ":") && ++tokens > maxTokens) throw tooLarge();
  }
  // JSON.parse performs syntax validation after these resource checks.
}

function cancelBody(request: Request): void { try { void request.body?.cancel().catch(() => {}); } catch {} }
function invalid() { return new ControllerError("Telemetry body must be valid UTF-8 JSON.", 400, "telemetry_body_invalid"); }
function tooLarge() { return new ControllerError("Telemetry body exceeds its byte or structure budget.", 413, "telemetry_batch_too_large"); }
