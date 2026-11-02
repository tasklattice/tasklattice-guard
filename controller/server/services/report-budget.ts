import { sql } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { ControllerError } from "../domain/errors.js";

export const REPORT_BATCH_CASES = 50;
export const REPORT_BATCH_BYTES = 1024 * 1024;
export const REPORT_CASE_BYTES = 4 * 1024 * 1024;
export const REPORT_DECODE_BYTES = 8 * 1024 * 1024;
export const REPORT_TOTAL_BYTES = 128 * 1024 * 1024;
export const REPORT_PAGE_BYTES = 512 * 1024;
export type ReportTransaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];
const busy = () => new ControllerError("Report processing is busy. Retry shortly.", 429, "report_busy", { retryAfterSeconds: 2 });

/** Bound admission before allocating decoded buffers or checking out a client. */
export class ReportBudget {
  private active = 0;
  private bytes = 0;
  private readonly queue: Array<{ bytes: number; start: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  constructor(private readonly concurrency: number, private readonly byteLimit = REPORT_TOTAL_BYTES, private readonly maxQueue = 8) {}
  state() { return { active: this.active, queued: this.queue.length, in_flight_bytes: this.bytes }; }
  async acquire(bytes: number): Promise<() => void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.byteLimit) throw new ControllerError("Report exceeds its memory budget.", 413, "report_too_large");
    const started = performance.now();
    await new Promise<void>((resolve, reject) => {
      const start = () => { this.active++; this.bytes += bytes; resolve(); };
      if (!this.queue.length && this.active < this.concurrency && this.bytes + bytes <= this.byteLimit) start();
      else {
        if (this.queue.length >= this.maxQueue) { reject(busy()); return; }
        const entry = { bytes, start, reject, timer: setTimeout(() => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          reject(busy());
          this.pump();
        }, 5_000) };
        this.queue.push(entry);
      }
    });
    console.info(JSON.stringify({ event: "validation.report_admitted", queue_ms: Math.round(performance.now() - started), ...this.state() }));
    let released = false;
    return () => { if (!released) { released = true; this.active--; this.bytes -= bytes; this.pump(); } };
  }
  async run<T>(bytes: number, task: () => Promise<T>): Promise<T> {
    const release = await this.acquire(bytes);
    try { return await task(); } finally { release(); }
  }
  private pump() {
    while (this.queue.length && this.active < this.concurrency && this.bytes + this.queue[0]!.bytes <= this.byteLimit) {
      const entry = this.queue.shift()!;
      clearTimeout(entry.timer);
      entry.start();
    }
  }
}

/** Slots are shared by every Controller using the same database schema. Never wait for
 * a slot while holding a connection; transaction-scoped locks release on every
 * success, cancellation, rollback, or disconnected backend. */
export async function reportDatabaseWork<T>(db: ControllerDatabase, kind: "read" | "write", task: (tx: ReportTransaction) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    const slots = kind === "read" ? 4 : 2;
    const namespace = kind === "read" ? 1735101 : 1735102;
    let acquired = false;
    for (let slot = 0; slot < slots; slot++) {
      const result = await tx.execute<{ acquired: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtext(current_schema()), ${namespace * 16 + slot}) AS acquired`);
      if (result.rows[0]?.acquired) { acquired = true; break; }
    }
    if (!acquired) throw busy();
    await tx.execute(sql`SELECT set_config('statement_timeout', '30000', true), set_config('lock_timeout', '5000', true), set_config('idle_in_transaction_session_timeout', '30000', true), set_config('work_mem', '4MB', true)`);
    return task(tx);
  });
}
