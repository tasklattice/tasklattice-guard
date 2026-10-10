import { describe, expect, it } from "vitest";

import {
  guardrailLifecycleStates,
  guardrailLifecycleTransitions,
  guardrailReadinessStates,
  guardrailVersionStates,
  guardrailVersionTransitions,
  endpointLifecycleStates,
  endpointLifecycleTransitions,
  endpointSetupStates,
  runnerPressureStates,
  runnerReconciliationStates,
  runnerStatuses,
  validationRunStates,
  validationRunTransitions,
} from "./lifecycle.js";

describe("Controller lifecycle contract", () => {
  it("keeps every state vocabulary unique", () => {
    for (const states of [
      guardrailLifecycleStates,
      guardrailVersionStates,
      guardrailReadinessStates,
      validationRunStates,
      endpointLifecycleStates,
      endpointSetupStates,
      runnerReconciliationStates,
      runnerPressureStates,
      runnerStatuses,
    ]) {
      expect(new Set(states).size).toBe(states.length);
    }
  });

  it("does not model registration as a durable Runner status", () => {
    expect(runnerStatuses).toEqual(["syncing", "ready", "busy", "saturated", "offline"]);
    expect(runnerStatuses).not.toContain("registered");
  });

  it("models evidence loss and confirmed restoration without changing version contents", () => {
    expect(guardrailLifecycleTransitions).toEqual({
      draft: ["active", "disabled"],
      active: ["draft", "disabled"],
      disabled: ["draft"],
    });
    expect(guardrailVersionTransitions).toEqual({
      pending: ["ready"],
      ready: ["pending"],
    });
  });

  it("allows validation terminal shortcuts and reversible Endpoint toggles", () => {
    expect(validationRunTransitions).toEqual({
      queued: ["running", "passed", "failed"],
      running: ["passed", "failed"],
      passed: [],
      failed: [],
    });
    expect(endpointLifecycleTransitions).toEqual({
      active: ["disabled"],
      disabled: ["active"],
    });
  });
});
