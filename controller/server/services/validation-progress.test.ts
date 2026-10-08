import { describe, expect, it, vi } from "vitest";
import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { ControlPlaneService } from "./control-plane.js";
import { advancesValidationProgress, type ValidationProgress } from "../../shared/validation-progress.js";

const progress: ValidationProgress = { phase: "executing", completedCases: 5, passedCases: 4, updatedAt: "2026-10-08T00:00:00Z" };

describe("observed test progress", () => {
  it("accepts actual advancement and report generation, but rejects stale or impossible observations", () => {
    expect(advancesValidationProgress(null, { ...progress, phase: "preparing", completedCases: 0, passedCases: 0 }, 10)).toBe(true);
    expect(advancesValidationProgress(progress, { ...progress, completedCases: 6 }, 10)).toBe(true);
    expect(advancesValidationProgress(progress, { ...progress, phase: "finalizing", completedCases: 10, passedCases: 9 }, 10)).toBe(true);
    for (const patch of [{}, { completedCases: 4 }, { completedCases: 11 }, { passedCases: 6 }, { completedCases: 6, passedCases: 6 }, { phase: "preparing" }, { phase: "finalizing" }]) {
      expect(advancesValidationProgress(progress, { ...progress, ...patch } as ValidationProgress, 10)).toBe(false);
    }
  });

  it.each(["queued", "running", "passed", "failed", "missing"])("persists progress only for unfinished runs (%s)", async status => {
    const set = vi.fn(() => ({ where: vi.fn(async () => {}) }));
    const row = { status, progress: null, metrics: { total: 10 } };
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ for: async () => status === "missing" ? [] : [row] }) }) }),
      update: () => ({ set }),
    };
    const db = { transaction: async (fn: (value: typeof tx) => Promise<void>) => fn(tx) } as unknown as ControllerDatabase;
    await new ControlPlaneService(db, {} as ControllerConfig).updateValidationProgress("run-1", progress);
    if (status === "queued" || status === "running") {
      expect(set).toHaveBeenCalledWith({ status: "running", progress: { ...progress, updatedAt: expect.any(String) } });
    } else expect(set).not.toHaveBeenCalled();
  });
});
