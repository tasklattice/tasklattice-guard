// @vitest-environment node
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControllerDatabase } from "../db/client.js";
import type { RuntimeEventInput } from "../domain/models.js";
import { writeRuntimeEvent } from "./runtime-event-write.js";

afterEach(() => vi.restoreAllMocks());

function writeFixture() {
  const onConflictDoUpdate = vi.fn<(update: { set: { metadata: SQL }; setWhere: SQL }) => void>();
  const onConflictDoNothing = vi.fn();
  const values = vi.fn(() => ({ onConflictDoUpdate, onConflictDoNothing }));
  const db = { insert: () => ({ values }) } as unknown as Pick<ControllerDatabase, "insert">;
  return { db, values, onConflictDoUpdate, onConflictDoNothing };
}

function capturedEvent(occurredAt: Date): RuntimeEventInput {
  return { id: "event", occurredAt, requestId: "call", runnerId: "runner", direction: "incoming",
    decision: "allow", durationMs: 1, metadata: {
      runtimeLogCaptured: true, contentCaptureStatus: "captured", contentCiphertext: "encrypted",
      contentBefore: [], contentAfter: [], httpRequest: {}, modelExchanges: [],
      modelEvidenceStatus: "captured", modelEvidenceCount: 2,
      findings: ["finding"], trace: ["step"], usage: { model_invocations: 1 },
    } };
}

describe("runtime event content expiry", () => {
  it("stores and enriches evidence without expired bodies at the 30-day cutoff", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-18T12:00:00Z"));
    const { db, values, onConflictDoNothing, onConflictDoUpdate } = writeFixture();
    const event = capturedEvent(new Date("2026-10-19T12:00:00Z"));

    await writeRuntimeEvent(db, event, "pool-a");

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ metadata: {
      runtimeLogCaptured: true, contentCaptureStatus: "captured",
      modelEvidenceStatus: "captured", modelEvidenceCount: 2,
      findings: ["finding"], trace: ["step"], usage: { model_invocations: 1 },
    } }));
    expect(onConflictDoNothing).not.toHaveBeenCalled();
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
    expect(event.metadata.contentCiphertext).toBe("encrypted");

    const { set, setWhere } = onConflictDoUpdate.mock.calls[0]![0];
    const dialect = new PgDialect();
    const enrichment = dialect.sqlToQuery(set.metadata);
    expect(JSON.parse(String(enrichment.params[0]))).toEqual({ runtimeLogCaptured: true, contentCaptureStatus: "captured",
      modelEvidenceStatus: "captured", modelEvidenceCount: 2 });
    const guard = dialect.sqlToQuery(setWhere);
    expect(guard.sql).toContain('"runtime_event"."project_id" IS NOT DISTINCT FROM excluded.project_id');
    expect(guard.sql).toContain("excluded.project_id IS NOT NULL");
    expect(guard.sql).toContain('"runtime_event"."occurred_at" =');
    expect(guard.params).toContain(event.occurredAt.toISOString());
  });

  it("retains encrypted content for eligible replay within the window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-18T12:00:00Z"));
    const { db, values, onConflictDoNothing, onConflictDoUpdate } = writeFixture();
    const event = capturedEvent(new Date("2026-10-19T12:00:00.001Z"));

    await writeRuntimeEvent(db, event);

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ metadata: event.metadata }));
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
    expect(onConflictDoNothing).not.toHaveBeenCalled();
  });
});
