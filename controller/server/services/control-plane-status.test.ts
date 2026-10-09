import { describe, expect, it, vi } from "vitest";
import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { ControlPlaneService } from "./control-plane.js";

function serviceWithSelectResults(results: unknown[][]) {
  const select = vi.fn(() => {
    const builder = {} as Record<string, unknown>;
    builder.from = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.orderBy = vi.fn(() => builder);
    builder.limit = vi.fn(async () => results.shift() ?? []);
    return builder;
  });
  return new ControlPlaneService({ select } as unknown as ControllerDatabase, {} as ControllerConfig);
}

const BASELINE = "20260904-193000.000Z";
const guardrail = { id: "guardrail-default", status: "active", draftRevision: 2 };
const version = { guardrailId: guardrail.id, version: BASELINE, artifactId: "artifact-1", status: "ready", sourceDraftRevision: 1 };
const artifact = { id: "artifact-1", guardrailId: guardrail.id, guardrailVersion: BASELINE, checksum: "checksum", signature: "signature",
  plan: { steps: [{ contract_ref: "tali.guard.pii.exact.v1", phases: ["input", "output"], parameters: [["policy_id", "pii"]] }],
    policy_bindings: [{ policy_id: "pii" }] } };
// Select order: guardrail, latest draft validation, the pinned baseline,
// baseline version, artifact.
const activeResults = () => [[guardrail], [], [{ baselineVersion: BASELINE }], [version], [artifact]] as unknown[][];

describe("Default Guardrail readiness", () => {
  it("requires a ready signed artifact with enabled checks", async () => {
    await expect(serviceWithSelectResults(activeResults()).defaultGuardrailReadiness()).resolves.toEqual({
      status: "ready", guardrailStatus: "active", baselineVersion: BASELINE,
      modelIndependent: true,
      coverage: { policyCount: 1, inputChecks: 1, outputChecks: 1, requiredModelBindings: [], hasUnknownDependencies: false },
      draft: { revision: 2, activeRevision: 1, validationStatus: null, validationFailureReason: null },
    });
  });
  it.each([
    ["running", "initializing"], ["failed", "unavailable"], ["queued", "initializing"],
  ])("shows first validation %s as %s without claiming published coverage", async (validation, status) => {
    const result = await serviceWithSelectResults([
      [guardrail], [{ status: validation, failureReason: "Test detail" }],
    ]).defaultGuardrailReadiness();
    expect(result).toMatchObject({ status, modelIndependent: null, coverage: null,
      draft: { validationStatus: validation, validationFailureReason: "Test detail" } });
  });
  it.each([
    ["missing artifact", 4, []],
    ["pending version", 3, [{ ...version, status: "pending" }]],
    ["wrong artifact", 3, [{ ...version, artifactId: "other" }]],
    ["wrong owner", 4, [{ ...artifact, guardrailId: "other" }]],
    ["wrong release", 4, [{ ...artifact, guardrailVersion: "other" }]],
    ["unsigned artifact", 4, [{ ...artifact, signature: "" }]],
    ["disabled guardrail", 0, [{ ...guardrail, status: "disabled" }]],
  ] as Array<[string, number, unknown[]]>)("does not call %s active", async (_name, index, values) => {
    const results = activeResults(); results[index] = values;
    await expect(serviceWithSelectResults(results).defaultGuardrailReadiness()).resolves.toMatchObject({
      status: "unavailable", guardrailStatus: "unavailable", modelIndependent: null, coverage: null,
    });
  });
  it("does not claim protection when the plan has no checks", async () => {
    const emptyPlan = activeResults(); emptyPlan[4] = [{ ...artifact, plan: { steps: [], policy_bindings: [] } }];
    await expect(serviceWithSelectResults(emptyPlan).defaultGuardrailReadiness()).resolves.toMatchObject({
      status: "unavailable", guardrailStatus: "active", modelIndependent: null,
    });
  });
  it("keeps the old release available while a model-dependent new draft fails validation", async () => {
    const results = activeResults();
    results[0] = [{ ...guardrail, draftConfig: { policyBindings: [{ policyId: "content-safety" }] } }];
    results[1] = [{ status: "failed", failureReason: "Model request failed." }];
    await expect(serviceWithSelectResults(results).defaultGuardrailReadiness()).resolves.toMatchObject({
      status: "ready", modelIndependent: true, draft: { activeRevision: 1, revision: 2, validationStatus: "failed" },
    });
  });
  it("derives model requirements from the active artifact even if the draft removed models", async () => {
    const results = activeResults();
    results[4] = [{ ...artifact, plan: { ...artifact.plan, steps: [{ contract_ref: "tali.guard.content-safety.v1", phases: ["output"] }] } }];
    await expect(serviceWithSelectResults(results).defaultGuardrailReadiness()).resolves.toMatchObject({
      status: "ready", modelIndependent: false, coverage: { requiredModelBindings: ["content_safety.output"] },
    });
  });
});
