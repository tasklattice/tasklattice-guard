import { describe, expect, it, vi } from "vitest";

import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { ControlPlaneService } from "./control-plane.js";

describe("Guardrail publication", () => {
  it("reactivates the Default Guardrail's ready current-draft version without recompiling", async () => {
    const guardrail = {
      id: "guardrail-default",
      draftRevision: 2,
      status: "active",
      activeVersion: "20260904-010000.001Z",
      activeArtifactId: "artifact-1",
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
    const defaultDeployment = {
      id: "deployment-default",
      guardrailId: guardrail.id,
      guardrailVersion: "20260904-010000.001Z",
      integrationId: null,
      poolId: "default",
      routeOrder: 100,
      enabled: true,
      trafficScope: { combinator: "and", conditions: [] },
    };
    const selectResults = [[guardrail], [validation], [readyVersion], [defaultDeployment]];
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

    expect(result).toMatchObject({ version: "20260904-020000.002Z", generation: 23, status: "ready" });
    expect(updatePayloads).toContainEqual({ guardrailVersion: "20260904-020000.002Z" });
    expect(updatePayloads).toContainEqual(expect.objectContaining({
      status: "active",
      activeVersion: "20260904-020000.002Z",
      activeArtifactId: "artifact-2",
      desiredGeneration: 23,
    }));
    expect(updatePayloads).toContainEqual(expect.objectContaining({ guardrailVersion: "20260904-020000.002Z" }));
    expect(inserted).toContainEqual(expect.objectContaining({
      kind: "runner.desired_state_changed",
      payload: expect.objectContaining({ version: "20260904-020000.002Z", artifactId: "artifact-2", generation: 23 }),
    }));
    expect(inserted).toContainEqual(expect.objectContaining({
      kind: "guardrail.version_activated",
      actorId: "admin-1",
      detail: { version: "20260904-020000.002Z", generation: 23, reusedArtifact: true },
    }));
    expect(inserted).toContainEqual(expect.objectContaining({
      kind: "deployment.default.restored",
      detail: expect.objectContaining({ guardrailVersion: "20260904-020000.002Z" }),
    }));
  });
});
