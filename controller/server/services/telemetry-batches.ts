import type { ControllerDatabase } from "../db/client.js";

type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];
export const TELEMETRY_BATCH_SIZE = 50;
export const TELEMETRY_TRANSACTION_TARGET_MS = 1_000;

/** Commit a bounded prefix, releasing the connection between chunks. A retry
 * replays committed chunks safely through event/cost/assignment unique IDs.
 * The time budget is checked between events; a single event remains atomic.
 */
export async function telemetryBatches<T>(db: ControllerDatabase, events: readonly T[], prepare: (
  tx: Transaction, batch: readonly T[],
) => Promise<{ write: (event: T) => Promise<void>; finish?: () => Promise<void> }>): Promise<void> {
  for (let offset = 0; offset < events.length;) {
    const batch = events.slice(offset, offset + TELEMETRY_BATCH_SIZE);
    offset += await db.transaction(async tx => {
      const deadline = performance.now() + TELEMETRY_TRANSACTION_TARGET_MS;
      const writer = await prepare(tx, batch);
      let written = 0;
      while (written < batch.length && (written === 0 || performance.now() < deadline)) {
        await writer.write(batch[written++]!);
      }
      await writer.finish?.();
      return written;
    });
  }
}
