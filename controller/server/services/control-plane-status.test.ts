import { describe, expect, it, vi } from "vitest";

import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { ControlPlaneService } from "./control-plane.js";

function serviceWithSelectResults(results: unknown[][]) {
  const select = vi.fn(() => {
    const builder = {} as Record<string, unknown>;
    builder.from = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.limit = vi.fn(async () => results.shift() ?? []);
    return builder;
  });
  return new ControlPlaneService({ select } as unknown as ControllerDatabase, {} as ControllerConfig);
}

describe("Default Guardrail readiness", () => {
  it("is ready only when the active artifact is routed through the default catch-all deployment", async () => {
    const service = serviceWithSelectResults([
      [{ id: "guardrail-default", activeArtifactId: "artifact-1", activeVersion: "20260904-193000.000Z" }],
      [{
        id: "deployment-default",
        enabled: true,
        guardrailId: "guardrail-default",
        guardrailVersion: "20260904-193000.000Z",
        poolId: "default",
        trafficScope: { combinator: "and", conditions: [] },
      }],
      [],
    ]);

    await expect(service.defaultGuardrailReadiness()).resolves.toEqual({
      status: "ready",
      guardrailStatus: "active",
      deploymentStatus: "active",
      activeVersion: "20260904-193000.000Z",
      modelIndependent: true,
    });
  });

  it("reports initialization while the first Default Guardrail artifact is compiling", async () => {
    const service = serviceWithSelectResults([
      [{ id: "guardrail-default", activeArtifactId: null, activeVersion: null }],
      [],
      [{ version: "20260904-193100.000Z" }],
    ]);

    await expect(service.defaultGuardrailReadiness()).resolves.toMatchObject({
      status: "initializing",
      guardrailStatus: "initializing",
      deploymentStatus: "initializing",
      activeVersion: null,
    });
  });

  it("does not claim basic protection when the Default Guardrail route is missing", async () => {
    const service = serviceWithSelectResults([
      [{ id: "guardrail-default", activeArtifactId: "artifact-1", activeVersion: "20260904-193000.000Z" }],
      [],
      [],
    ]);

    await expect(service.defaultGuardrailReadiness()).resolves.toMatchObject({
      status: "unavailable",
      guardrailStatus: "active",
      deploymentStatus: "unavailable",
    });
  });
});
