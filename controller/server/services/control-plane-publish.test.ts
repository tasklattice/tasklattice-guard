import { describe, expect, it, vi } from "vitest";

import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { ControlPlaneService } from "./control-plane.js";

describe("Guardrail publication", () => {
  it("returns the existing version when the same tested draft is published again, changing nothing", async () => {
    const guardrail = {
      id: "guardrail-default",
      draftRevision: 2,
      status: "active",
    };
    const validation = { id: "validation-2", sourceDraftRevision: 2, status: "passed", createdAt: new Date("2026-09-04T02:00:00.002Z") };
    const readyVersion = {
      guardrailId: guardrail.id,
      version: "20260904-020000.002Z",
      generation: 18,
      sourceDraftRevision: 2,
      status: "ready",
      artifactId: "artifact-2",
    };
    const selectResults = [[guardrail], [validation], [readyVersion]];
    const select = vi.fn(() => {
      const builder = {} as Record<string, unknown>;
      builder.from = vi.fn(() => builder);
      builder.where = vi.fn(() => builder);
      builder.orderBy = vi.fn(() => builder);
      builder.limit = vi.fn(async () => selectResults.shift() ?? []);
      builder.for = vi.fn(async () => selectResults.shift() ?? []);
      return builder;
    });
    const updatePayloads: Array<Record<string, unknown>> = [];
    const update = vi.fn(() => {
      const builder = {} as Record<string, unknown>;
      builder.set = vi.fn((value: Record<string, unknown>) => {
        updatePayloads.push(value);
        return builder;
      });
      builder.where = vi.fn(() => builder);
      builder.returning = vi.fn(async () => [{ desiredGeneration: 23 }]);
      return builder;
    });
    const inserted: Array<Record<string, unknown>> = [];
    const insert = vi.fn(() => ({
      values: vi.fn(async (value: Record<string, unknown>) => {
        inserted.push(value);
      }),
    }));
    const tx = { select, update, insert };
    const db = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as ControllerDatabase;

    const result = await new ControlPlaneService(db, {} as ControllerConfig).requestGuardrailPublish({
      guardrailId: guardrail.id,
      actorId: "admin-1",
      compilerAvailable: false,
    });

    expect(result).toMatchObject({ version: "20260904-020000.002Z", generation: 18, status: "ready" });
    // No pointer moves and nothing is redistributed: the version already exists.
    expect(updatePayloads.filter((value) => "desiredGeneration" in value)).toEqual([]);
    expect(inserted).toEqual([]);
  });
});
