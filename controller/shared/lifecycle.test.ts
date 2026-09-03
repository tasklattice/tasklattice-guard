import { describe, expect, it } from "vitest";

import {
  guardrailLifecycleStates,
  guardrailLifecycleTransitions,
  guardrailReadinessStates,
  guardrailVersionStates,
  guardrailVersionTransitions,
  integrationLifecycleStates,
  integrationLifecycleTransitions,
  integrationSetupStates,
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
      integrationLifecycleStates,
      integrationSetupStates,
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

  it("makes Guardrail deletion and version completion terminal", () => {
    expect(guardrailLifecycleTransitions).toEqual({
      draft: ["active", "disabled"],
      active: ["disabled"],
      disabled: [],
    });
    expect(guardrailVersionTransitions).toEqual({
      compiling: ["ready", "failed"],
      ready: [],
      failed: [],
    });
  });

  it("allows validation terminal shortcuts and reversible Integration toggles", () => {
    expect(validationRunTransitions).toEqual({
      queued: ["running", "passed", "failed"],
      running: ["passed", "failed"],
      passed: [],
      failed: [],
    });
    expect(integrationLifecycleTransitions).toEqual({
      active: ["disabled"],
      disabled: ["active"],
    });
  });
});
