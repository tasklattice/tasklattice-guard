import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { ControlPlaneService } from "./control-plane.js";

describe("Runner registration removal", () => {
  it("keeps the GuardRails 0 desired capacity at two or more", async () => {
    const db = { transaction: vi.fn() } as unknown as ControllerDatabase;
    const update = new ControlPlaneService(db, {} as ControllerConfig).updateRunnerPool({
      id: "default",
      desiredReplicas: 1,
      safeRpsPerRunner: 50,
      maxConcurrencyPerRunner: 64,
      actorId: "admin-1",
    });

    await expect(update).rejects.toMatchObject({
      status: 422,
      detail: { minimumDesiredReplicas: 2 },
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it.each([false, true])("removes only the current registration and records immutable audit context (force=%s)", async (force) => {
    const removed = {
      runnerId: "runner-offline",
      bootId: "boot-1",
      poolId: "default",
      status: force ? "syncing" : "offline",
      appliedGeneration: 0,
      desiredGeneration: 2,
      lastHeartbeatAt: new Date("2026-08-20T10:00:00.000Z"),
      disconnectedAt: new Date("2026-08-20T10:00:30.000Z"),
    };
    const returning = vi.fn().mockResolvedValue([removed]);
    const deleteWhere = vi.fn((_condition: SQL) => ({ returning }));
    const deleteRow = vi.fn(() => ({ where: deleteWhere }));
    const auditValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn(() => ({ values: auditValues }));
    const tx = { delete: deleteRow, insert };
    const db = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as ControllerDatabase;

    await new ControlPlaneService(db, {} as ControllerConfig).removeRunnerInstance({
      runnerId: removed.runnerId,
      actorId: "admin-1",
      ...(force ? { force: true, bootId: removed.bootId } : {}),
    });

    expect(deleteRow).toHaveBeenCalledOnce();
    const condition = new PgDialect().sqlToQuery(deleteWhere.mock.calls[0]![0]);
    expect(condition.params).toEqual(force ? [removed.runnerId, "offline", "syncing", removed.bootId] : [removed.runnerId, "offline"]);
    if (force) expect(condition.sql).toContain('"runner_instance"."boot_id" =');
    expect(insert).toHaveBeenCalledOnce();
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
      kind: "runner_instance.removed",
      actorId: "admin-1",
      resourceType: "runner_instance",
      resourceId: removed.runnerId,
      detail: {
        ...(force ? { force: true, status: "syncing", appliedGeneration: 0, desiredGeneration: 2 } : {}),
        bootId: removed.bootId,
        poolId: removed.poolId,
        lastHeartbeatAt: "2026-08-20T10:00:00.000Z",
        disconnectedAt: "2026-08-20T10:00:30.000Z",
      },
    }));
  });

  it.each([false, true])("rejects removing a Runner that has recovered (force=%s)", async (force) => {
    const returning = vi.fn().mockResolvedValue([]);
    const tx = {
      delete: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([{ status: "ready" }]),
          })),
        })),
      })),
      insert: vi.fn(),
    };
    const db = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as ControllerDatabase;

    const removal = new ControlPlaneService(db, {} as ControllerConfig).removeRunnerInstance({
      runnerId: "runner-ready",
      actorId: "admin-1",
      ...(force ? { force: true, bootId: "old-boot" } : {}),
    });

    await expect(removal).rejects.toMatchObject({
      code: force ? "runner_removal_conflict" : "runner_not_offline",
      status: 409,
    });
    expect(tx.insert).not.toHaveBeenCalled();
  });
});
